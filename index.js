require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActivityType
} = require("discord.js");

// ─── Constants ────────────────────────────────────────────────────────────────

const PREFIX = ".";
const CACHE_FILE = path.join(__dirname, "cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SESSION_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const COOLDOWN_MS = 3_000;                  // 3 seconds per user
const RESULTS_PER_QUERY = 20;
const RR_CHALLENGE_TIMEOUT_MS = 30_000;     // 3 seconds to accept/decline a challenge
const RR_TURN_TIMEOUT_MS = 90_000;          // 90 seconds to pull the trigger before AFK kick
const RRM_LOBBY_TIMEOUT_MS = 45_000;        // 45 seconds to fill the multiplayer lobby
const RRM_MAX_PLAYERS = 6;

// ─── Startup Validation ───────────────────────────────────────────────────────

const REQUIRED_ENV = ["DISCORD_TOKEN", "SERVER_ID", "SERP_API_KEY"];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`[FATAL] Missing environment variable: ${key}`);
        process.exit(1);
    }
}

// ─── Persistent Cache ─────────────────────────────────────────────────────────

function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    } catch {
        return {};
    }
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

function pruneCache(cache) {
    const now = Date.now();
    let pruned = 0;
    for (const key of Object.keys(cache)) {
        if (now - cache[key].ts > CACHE_TTL_MS) {
            delete cache[key];
            pruned++;
        }
    }
    if (pruned > 0) {
        saveCache(cache);
        console.log(`[Cache] Pruned ${pruned} expired entries`);
    }
}

const cache = loadCache();
pruneCache(cache);

// Auto-cleanup every hour
setInterval(() => pruneCache(cache), 60 * 60 * 1000);

// ─── In-Memory State ──────────────────────────────────────────────────────────

/** sessions: Map<messageId, { images, index, query, owner, timer, messageRef }> */
const sessions = new Map();

/** cooldowns: Map<userId, lastUsedTimestamp> */
const cooldowns = new Map();

/** setMentions: Map<userId, textToMatch> */
const setMentions = new Map();

// ─── Snipe Stores (keyed by channelId) ───────────────────────────────────────

const deletedMessages = new Map();
const deletedMessageStack = new Map();
const editedMessages = new Map();
const MSNIPE_LIMIT = 25;

// ─── Russian Roulette Store (keyed by channelId) ──────────────────────────────

const rrGames = new Map();
const RR_TOTAL_SHOTS = 6;

// ─── Multiplayer Russian Roulette Store (keyed by channelId) ─────────────────

const rrmGames = new Map();

// ─── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

client.once("ready", () => {
    console.log(`[Ready] Logged in as ${client.user.tag}`);

    client.user.setActivity('.help', {
        type: ActivityType.Playing
    });

    console.log(`[Ready] Gateway ping: ${client.ws.ping}ms`);
});

// ─── Shared RR Helpers ────────────────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function buildGame() {
    const chamber = Array(RR_TOTAL_SHOTS).fill(false);
    chamber[Math.floor(Math.random() * RR_TOTAL_SHOTS)] = true;
    const shotsOrder = shuffle([0, 1, 2, 3, 4, 5]);
    return { chamber, shotsOrder };
}

function rrStatusBar(shotsFired) {
    return Array.from({ length: RR_TOTAL_SHOTS }, (_, i) =>
        i < shotsFired ? "🔘" : "⚪"
    ).join(" ");
}

function shootRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("rr_shoot")
            .setLabel("🔫 Pull the Trigger")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

// ─── Regular RR Timeouts ──────────────────────────────────────────────────────

function scheduleRRChallengeTimeout(cid, channel, challengeMessage) {
    const game = rrGames.get(cid);
    if (!game) return;

    game.challengeTimer = setTimeout(async () => {
        const g = rrGames.get(cid);
        if (!g || !g.pending) return;

        rrGames.delete(cid);
        console.log(`[RR] Challenge in channel ${cid} expired`);

        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rr_accept").setLabel("✅ Accept").setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId("rr_decline").setLabel("❌ Decline").setStyle(ButtonStyle.Secondary).setDisabled(true)
        );
        challengeMessage?.edit({ components: [disabledRow] }).catch(() => { });

        const expiredEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("⏰ Challenge Expired")
            .setDescription(
                `**${g.names[g.challenged]}** didn't respond to the challenge in time.\n` +
                `The game has been cancelled.`
            )
            .setFooter({ text: "30 seconds with no response" })
            .setTimestamp();

        await channel.send({ embeds: [expiredEmbed] }).catch(() => { });
    }, RR_CHALLENGE_TIMEOUT_MS);
}

function scheduleRRTurnTimeout(cid, channel, guild) {
    const game = rrGames.get(cid);
    if (!game) return;

    clearRRTurnTimeout(game);

    game.turnTimer = setTimeout(async () => {
        const g = rrGames.get(cid);
        if (!g || g.pending) return;

        rrGames.delete(cid);
        console.log(`[RR] Turn timed out in channel ${cid}`);

        g.gameMessage?.edit({ components: [shootRow(true)] }).catch(() => { });

        const afkId = g.turn;
        const afkName = g.names[afkId];
        const winnerId = g.players.find(id => id !== afkId);
        const winnerName = g.names[winnerId] ?? "The other player";

        const afkEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("💤 AFK Detected — Game Over")
            .setDescription(
                `**${afkName}** went AFK and didn't pull the trigger in **90 seconds**.\n\n` +
                `🏆 **${winnerName}** wins by default!\n` +
                `👢 Kicking **${afkName}** for going AFK...`
            )
            .setFooter({ text: "90 seconds of no response" })
            .setTimestamp();

        await channel.send({ embeds: [afkEmbed] }).catch(() => { });

        try {
            const afkMember = await guild.members.fetch(afkId);
            await afkMember.kick("Went AFK during Russian Roulette 💤");
        } catch {
            await channel.send(`⚠️ Couldn't kick **${afkName}** — missing \`Kick Members\` permission or they outrank me.`).catch(() => { });
        }
    }, RR_TURN_TIMEOUT_MS);
}

function clearRRChallengeTimeout(game) {
    if (game?.challengeTimer) {
        clearTimeout(game.challengeTimer);
        game.challengeTimer = null;
    }
}

function clearRRTurnTimeout(game) {
    if (game?.turnTimer) {
        clearTimeout(game.turnTimer);
        game.turnTimer = null;
    }
}

// ─── Multiplayer RR Helpers ───────────────────────────────────────────────────

function freshRRMRound(game) {
    const chamber = Array(RR_TOTAL_SHOTS).fill(false);
    chamber[Math.floor(Math.random() * RR_TOTAL_SHOTS)] = true;
    game.chamber = chamber;
    game.shotsOrder = shuffle([0, 1, 2, 3, 4, 5]);
    game.shotsFired = 0;
    game.turnOrder = shuffle([...game.players]);
    game.turnIndex = 0;
    game.turn = game.turnOrder[0];
    return game;
}

function buildRRMGame(players) {
    return freshRRMRound({
        players: [...players],
        eliminated: [],
        round: 1,
        turn: null,
        turnOrder: [],
        turnIndex: 0,
        shotsFired: 0,
        chamber: [],
        shotsOrder: [],
        gameMessage: null,
        turnTimer: null
    });
}

function rrmPlayerList(players) {
    return players.map((p, i) => `${i + 1}. **${p.name}**`).join("\n");
}

function rrmLobbyEmbed(host, players, lobbyClosed = false) {
    return new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("🔫 Russian Roulette — Multiplayer Lobby")
        .setDescription(
            `**${host.name}** opened a multiplayer Russian Roulette lobby!\n\n` +
            `> 🔴 One bullet, six chambers, random pull order\n` +
            `> 💀 Each round, one player is eliminated and kicked\n` +
            `> 🏆 Last survivor wins\n` +
            `> ⚠️ **Save your server invite before joining!**\n\n` +
            `**Players (${players.length}/${RRM_MAX_PLAYERS}):**\n` +
            rrmPlayerList(players)
        )
        .setFooter({ text: lobbyClosed ? "Lobby closed." : `45 seconds to join • 2–${RRM_MAX_PLAYERS} players` })
        .setTimestamp();
}

function scheduleRRMTurnTimeout(cid, channel, guild) {
    const game = rrmGames.get(cid);
    if (!game) return;

    clearRRMTurnTimeout(game);

    game.turnTimer = setTimeout(async () => {
        const g = rrmGames.get(cid);
        if (!g) return;

        const afk = g.turn;
        console.log(`[RRM] Turn timed out in ${cid} — AFK kick: ${afk.name}`);

        g.gameMessage?.edit({ components: [shootRow(true)] }).catch(() => { });

        const afkEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("💤 AFK Detected")
            .setDescription(
                `**${afk.name}** didn't pull the trigger in **90 seconds**.\n` +
                `They are eliminated and kicked for going AFK.`
            )
            .setFooter({ text: "90 seconds of no response" })
            .setTimestamp();

        await channel.send({ embeds: [afkEmbed] }).catch(() => { });

        try {
            await afk.member.kick("Went AFK during Multiplayer Russian Roulette 💤");
        } catch {
            await channel.send(`⚠️ Couldn't kick **${afk.name}** — missing permission or they outrank me.`).catch(() => { });
        }

        await eliminateRRMPlayer(cid, channel, guild, afk);
    }, RR_TURN_TIMEOUT_MS);
}

function clearRRMTurnTimeout(game) {
    if (game?.turnTimer) {
        clearTimeout(game.turnTimer);
        game.turnTimer = null;
    }
}

async function eliminateRRMPlayer(cid, channel, guild, eliminated) {
    const game = rrmGames.get(cid);
    if (!game) return;

    clearRRMTurnTimeout(game);

    game.players = game.players.filter(p => p.id !== eliminated.id);
    game.eliminated.push(eliminated);

    if (game.players.length === 1) {
        const winner = game.players[0];
        rrmGames.delete(cid);

        const winEmbed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle("🏆 We Have a Winner!")
            .setDescription(
                `The gun has gone silent.\n\n` +
                `🥇 **${winner.name}** is the last one standing!\n\n` +
                `**Elimination order:**\n` +
                game.eliminated.map((p, i) => `${i + 1}. ~~${p.name}~~`).join("\n")
            )
            .setFooter({ text: "Multiplayer Russian Roulette — Better luck next time" })
            .setTimestamp();

        return channel.send({ embeds: [winEmbed] });
    }

    let nextTurn = null;
    for (let i = game.turnIndex + 1; i < game.turnOrder.length; i++) {
        if (game.players.find(p => p.id === game.turnOrder[i].id)) {
            game.turnIndex = i;
            nextTurn = game.turnOrder[i];
            break;
        }
    }

    if (!nextTurn) {
        game.round++;
        freshRRMRound(game);

        const nextRoundEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle(`🔄 Round ${game.round} Begins`)
            .setDescription(
                `**${game.players.length} players** remain alive.\n\n` +
                rrmPlayerList(game.players) + `\n\n` +
                `A fresh revolver is loaded. Good luck. 🍀\n\n` +
                `<@${game.turn.id}> goes first this round!`
            )
            .setTimestamp();

        const gameMsg = await channel.send({ embeds: [nextRoundEmbed], components: [shootRow(false)] });
        game.gameMessage = gameMsg;
        scheduleRRMTurnTimeout(cid, channel, guild);
        return;
    }

    game.turn = nextTurn;

    const continueEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle(`🔫 Round ${game.round} — Keep Going`)
        .setDescription(
            `Chamber: ${rrStatusBar(game.shotsFired)}\n` +
            `Shots fired: **${game.shotsFired}/${game.players.length + game.eliminated.filter(e => game.round === game.round).length}**\n\n` +
            `<@${game.turn.id}> — it's your turn! 🤞`
        )
        .setFooter({ text: `Round ${game.round} • ${game.players.length} players remaining` })
        .setTimestamp();

    const gameMsg = await channel.send({ embeds: [continueEmbed], components: [shootRow(false)] });
    game.gameMessage = gameMsg;
    scheduleRRMTurnTimeout(cid, channel, guild);
}

// ─── Snipe Helpers ────────────────────────────────────────────────────────────

function formatTimestamp(date) {
    return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function truncate(str, max = 1024) {
    if (!str) return "_[no text content]_";
    return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function avatarURL(user) {
    return user.displayAvatarURL({ dynamic: true, size: 256 });
}

function buildDeleteEmbed(data, channelId, index = null, total = null) {
    const title = index !== null
        ? `🗑️ Deleted Message  [${index}/${total}]`
        : "🗑️ Sniped — Last Deleted Message";

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle(title)
        .setAuthor({ name: data.author.tag, iconURL: avatarURL(data.author) })
        .addFields(
            { name: "📝 Content", value: truncate(data.content), inline: false },
            { name: "📌 Channel", value: `<#${channelId}>`, inline: true },
            { name: "🕐 Deleted", value: formatTimestamp(data.deletedAt), inline: true }
        )
        .setFooter({ text: `Author ID: ${data.author.id}` })
        .setTimestamp();

    if (data.attachments?.length > 0) {
        embed.setImage(data.attachments[0]);
        if (data.attachments.length > 1) {
            embed.addFields({
                name: "📎 Attachments",
                value: data.attachments.map((a, i) => `[Attachment ${i + 1}](${a})`).join("\n"),
                inline: false
            });
        }
    }
    return embed;
}

function buildEditEmbed(data, channelId) {
    return new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle("✏️ Sniped — Last Edited Message")
        .setAuthor({ name: data.author.tag, iconURL: avatarURL(data.author) })
        .addFields(
            { name: "📝 Before", value: truncate(data.before), inline: false },
            { name: "✅ After", value: truncate(data.after), inline: false },
            { name: "📌 Channel", value: `<#${channelId}>`, inline: true },
            { name: "🕐 Edited", value: formatTimestamp(data.editedAt), inline: true },
            { name: "🔗 Jump", value: data.url, inline: true }
        )
        .setFooter({ text: `Author ID: ${data.author.id}` })
        .setTimestamp();
}

// ─── Image Search Helpers ─────────────────────────────────────────────────────

function buildImgEmbed(session) {
    const img = session.images[session.index];
    return new EmbedBuilder()
        .setTitle(truncateTitle(img.title, 256))
        .setDescription(`Image ${session.index + 1} / ${session.images.length}`)
        .setImage(img.url)
        .setFooter({ text: `Search: ${session.query}` });
}

function buildDynamicRow(session) {
    const img = session.images[session.index];
    const sourceUrl = img.source || img.url;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("prev")
            .setLabel("⬅ Prev")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("next")
            .setLabel("➡ Next")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setLabel("🔗 Source")
            .setStyle(ButtonStyle.Link)
            .setURL(validUrl(sourceUrl)),
        new ButtonBuilder()
            .setCustomId("download")
            .setLabel("💾 Download")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId("delete")
            .setLabel("🗑 Delete")
            .setStyle(ButtonStyle.Danger)
    );
}

function validUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol === "http:" || u.protocol === "https:") return url;
    } catch { }
    return "https://images.google.com";
}

function truncateTitle(str, max) {
    if (!str) return "Untitled";
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function scheduleSessionExpiry(messageId) {
    return setTimeout(() => {
        const session = sessions.get(messageId);
        if (!session) return;
        sessions.delete(messageId);
        session.messageRef?.edit({ components: [] }).catch(() => { });
        console.log(`[Session] Expired: ${messageId}`);
    }, SESSION_TTL_MS);
}

// ─── Message Events ───────────────────────────────────────────────────────────

client.on("messageDelete", (message) => {
    if (message.partial) return;
    if (message.author?.bot) return;
    if (message.guild?.id !== process.env.SERVER_ID) return;

    const payload = {
        author: message.author,
        content: message.content || "",
        attachments: [...message.attachments.values()].map(a => a.proxyURL),
        deletedAt: new Date()
    };

    const cid = message.channel.id;
    deletedMessages.set(cid, payload);

    if (!deletedMessageStack.has(cid)) deletedMessageStack.set(cid, []);
    const stack = deletedMessageStack.get(cid);
    stack.unshift(payload);
    if (stack.length > MSNIPE_LIMIT) stack.length = MSNIPE_LIMIT;
});

client.on("messageUpdate", (oldMessage, newMessage) => {
    if (oldMessage.partial || newMessage.partial) return;
    if (newMessage.author?.bot) return;
    if (newMessage.guild?.id !== process.env.SERVER_ID) return;
    if (oldMessage.content === newMessage.content) return;

    editedMessages.set(newMessage.channel.id, {
        author: newMessage.author,
        before: oldMessage.content || "",
        after: newMessage.content || "",
        editedAt: new Date(),
        url: newMessage.url
    });
});

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.guild?.id !== process.env.SERVER_ID) return;

    const cid = message.channel.id;
    const trimmed = message.content.trim();
    const lower = trimmed.toLowerCase();

    // ── Keyword Mention Matrix Processor ───────────────────────────────────────
    // ── Keyword Mention Matrix Processor ───────────────────────────────────────
    for (const [userId, targetText] of setMentions.entries()) {
        if (lower.includes(targetText.toLowerCase())) {
            try {
                const targetUser = await client.users.fetch(userId);
                if (!targetUser) continue;

                // Grab the current message along with its 10 preceding context messages
                const contextMessages = await message.channel.messages.fetch({ limit: 11, before: message.id });
                const chronologicalOrder = [...contextMessages.values()].reverse();
                chronologicalOrder.push(message); // Include the actual matched message string

                const contextEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`🔔 Keyword Tracker Matched: "${targetText}"`)
                    .setDescription(`Your watch keyword was mentioned in <#${cid}>. Here is your context:`)
                    .setTimestamp();

                // Clean formatting: Just Username and the Message content
                const messageLog = chronologicalOrder.map(msg => {
                    return `**${msg.author.username}**: ${truncate(msg.content, 180)}`;
                }).join("\n");

                contextEmbed.addFields({ name: "💬 Channel Context Logs", value: messageLog || "_No plain text history found_" });

                await targetUser.send({ embeds: [contextEmbed] });
            } catch (err) {
                console.error(`[Mention System Error] Failed context DM relay to user ${userId}:`, err.message);
            }
        }
    }

    // ── .sm Command Handler ───────────────────────────────────────────────────
    if (lower.startsWith(`${PREFIX}sm`)) {
        const args = trimmed.slice(PREFIX.length + 2).trim().split(/ +/);
        const subCommand = args[0]?.toLowerCase();

        if (!subCommand) {
            return message.reply("❌ Usage:\n`• .sm <text>` — Setup track matching string.\n`• .sm clear` — Delete current rule configuration.");
        }

        if (subCommand === "clear") {
            if (!setMentions.has(message.author.id)) {
                return message.reply("❌ You do not have an active keyword setmention alert active tracker to clear.");
            }
            setMentions.delete(message.author.id);
            return message.reply("🗑️ Successfully removed your active phrase tracker keyword rule config.");
        }

        // Setup a tracking query
        const matchPhrase = trimmed.slice(PREFIX.length + 3).trim();
        if (setMentions.has(message.author.id)) {
            return message.reply(`❌ You already have an active profile rule watch. Run \`${PREFIX}sm clear\` first before building another keyword target context profile structure.`);
        }

        setMentions.set(message.author.id, matchPhrase);
        return message.reply(`✅ Keyword tracker locked! Watch rule target set to: \`${matchPhrase}\`. You will receive a direct DM string containing a 10-message back-channel history context whenever this exact line structure pattern is typed here.`);
    }

    // ── .ping ──────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}ping`) {
        const apiPing = client.ws.ping;
        const start = Date.now();
        const sent = await message.reply("🏓 Pinging…");
        const rtt = Date.now() - start;
        const bar = (ms) => ms < 100 ? "🟢" : ms < 250 ? "🟡" : "🔴";
        return sent.edit(
            `🏓 **Pong!**\n` +
            `${bar(rtt)}  Message RTT: **${rtt}ms**\n` +
            `${bar(apiPing)}  API Ping:     **${apiPing}ms**`
        );
    }

    // ── .help ──────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}help`) {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("📖 Command List")
            .setDescription("Here's everything this bot can do:")
            .addFields(
                { name: "🏓 `.ping`", value: "Check if the bot is alive and view latency.", inline: false },
                { name: "🔔 `.sm <text>`", value: "Set up a DM mention logger. Clear with `.sm clear` before defining new words.", inline: false },
                { name: "🖼️ `.img <query>`", value: "Search Google Images and browse with buttons. ⬅ ➡ navigate, 🔗 source, 💾 download, 🗑 remove.", inline: false },
                { name: "📡 `.usage`", value: "Check SerpAPI quota and monthly usage.", inline: false },
                { name: "🗑️ `.snipe`", value: "Show the **last deleted message** in this channel.", inline: false },
                { name: "📜 `.msnipe`", value: "Show the last **up to 25 deleted messages** in this channel.", inline: false },
                { name: "✏️ `.esnipe`", value: "Show the **last edited message** in this channel with before/after diff.", inline: false },
                { name: "🔫 `.rr @user`", value: "Challenge someone to 1v1 Russian Roulette — Loser gets kicked.", inline: false },
                { name: "🔫 `.rrm`", value: "Open a **multiplayer** Russian Roulette lobby (2–6 players).", inline: false }
            )
            .setFooter({ text: "All snipe commands are channel-specific." })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    }

    // ── .usage ─────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}usage`) {
        console.log(`[Usage] Requested by ${message.author.tag}`);
        let ack;
        try {
            ack = await message.reply("⏳ Fetching SerpAPI usage…");
        } catch (e) {
            console.error("[Usage] Could not send ack:", e.message);
            return;
        }

        try {
            const { data } = await axios.get("https://serpapi.com/account.json", {
                params: { api_key: process.env.SERP_API_KEY }
            });

            const pct = data.searches_per_month
                ? ((data.this_month_usage / data.searches_per_month) * 100).toFixed(1)
                : "N/A";

            const bar = (used, total) => {
                if (!total) return "";
                const filled = Math.round((used / total) * 10);
                return "█".repeat(filled) + "░".repeat(10 - filled);
            };

            return ack.edit(
                `📡 **SerpAPI Account — ${data.plan_name}**\n\n` +
                `🔍  This month:   **${data.this_month_usage}** / **${data.searches_per_month}** searches (${pct}%)\n` +
                `     \`${bar(data.this_month_usage, data.searches_per_month)}\`\n` +
                `✅  Plan left:    **${data.plan_searches_left}**\n` +
                `💰  Extra credits: **${data.extra_credits}**\n` +
                `🌐  Total left:   **${data.total_searches_left}**\n` +
                `⚡  Last hour:    **${data.last_hour_searches}** / **${data.account_rate_limit_per_hour}** (rate limit)`
            );
        } catch (error) {
            console.error("[Usage] API error:", error.response?.data || error.message);
            return ack.edit("❌ Failed to fetch SerpAPI usage. Check console for details.");
        }
    }

    // ── @mention ───────────────────────────────────────────────────────────
    if (message.mentions.users.has(client.user.id) && !trimmed.startsWith(PREFIX) && !message.reference) {
        const apiPing = client.ws.ping;
        const start = Date.now();
        const sent = await message.reply(`👋 Hey! Use \`${PREFIX}img <query>\` to search images.\n🏓 Pinging…`);
        const rtt = Date.now() - start;
        const bar = (ms) => ms < 100 ? "🟢" : ms < 250 ? "🟡" : "🔴";
        return sent.edit(
            `👋 Hey! Use \`${PREFIX}img <query>\` to search for images.\n\n` +
            `${bar(rtt)}  Message RTT: **${rtt}ms**\n` +
            `${bar(apiPing)}  API Ping:     **${apiPing}ms**`
        );
    }

    // ── .snipe ─────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}snipe`) {
        const data = deletedMessages.get(cid);
        if (!data) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("🔍 No recently deleted messages found in this channel.")]
            });
        }
        return message.reply({ embeds: [buildDeleteEmbed(data, cid)] });
    }

    // ── .msnipe ────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}msnipe`) {
        const stack = deletedMessageStack.get(cid);
        if (!stack || stack.length === 0) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("🔍 No recently deleted messages found in this channel.")]
            });
        }
        const BATCH = 10;
        for (let i = 0; i < stack.length; i += BATCH) {
            const embeds = stack.slice(i, i + BATCH).map((d, j) =>
                buildDeleteEmbed(d, cid, i + j + 1, stack.length)
            );
            await message.channel.send({ embeds });
        }
        return;
    }

    // ── .esnipe ────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}esnipe`) {
        const data = editedMessages.get(cid);
        if (!data) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("🔍 No recently edited messages found in this channel.")]
            });
        }
        return message.reply({ embeds: [buildEditEmbed(data, cid)] });
    }

    // ── .rr @user ──────────────────────────────────────────────────────────
    if (lower.startsWith(`${PREFIX}rr `)) {
        const target = message.mentions.members?.first();

        if (!target) return message.reply("Usage: `.rr @user` — mention someone to challenge them.");
        if (target.id === message.author.id) return message.reply("❌ You can't challenge yourself... although that's kinda brave.");
        if (target.user.bot) return message.reply("❌ Bots don't die. Challenge a real person.");
        if (rrGames.has(cid)) return message.reply("❌ A game is already running in this channel. Wait for it to finish.");
        if (rrmGames.has(cid)) return message.reply("❌ A multiplayer game is already running in this channel.");

        const players = [message.author.id, target.id];
        const firstIndex = Math.floor(Math.random() * 2);
        const { chamber, shotsOrder } = buildGame();

        const game = {
            players,
            names: {
                [message.author.id]: message.member.displayName,
                [target.id]: target.displayName
            },
            turn: players[firstIndex],
            chamber,
            shotsOrder,
            shotsFired: 0,
            pending: true,
            challenger: message.author.id,
            challenged: target.id,
            gameMessage: null
        };

        rrGames.set(cid, game);

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🔫 Russian Roulette — Challenge Issued!")
            .setDescription(
                `**${message.member.displayName}** has challenged **${target.displayName}** to a game of **Russian Roulette**.\n\n` +
                `> 🔴 A revolver is loaded with **1 bullet** hidden in **6 chambers**\n` +
                `> 🎲 The chambers are pulled in a **random order**\n` +
                `> 💥 Each player takes turns — whoever gets the bullet is **kicked from the server**\n\n` +
                `**${target.displayName}**, do you accept the challenge?`
            )
            .setFooter({ text: "6 chambers • 1 bullet • random order" })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rr_accept").setLabel("✅ Accept").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("rr_decline").setLabel("❌ Decline").setStyle(ButtonStyle.Secondary)
        );

        const challengeMsg = await message.channel.send({ embeds: [embed], components: [row] });
        scheduleRRChallengeTimeout(cid, message.channel, challengeMsg);
        return;
    }

    // ── .rrm ───────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}rrm`) {
        if (rrGames.has(cid)) return message.reply("❌ A 1v1 game is already running in this channel.");
        if (rrmGames.has(cid)) return message.reply("❌ A multiplayer game is already running in this channel.");

        const host = {
            id: message.author.id,
            name: message.member.displayName,
            member: message.member
        };

        const lobby = {
            host,
            players: [host],
            started: false,
            lobbyMessage: null,
            lobbyTimer: null
        };

        rrmGames.set(cid, lobby);

        const joinRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rrm_join").setLabel("✅ Join").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("rrm_start").setLabel("🚀 Start Game").setStyle(ButtonStyle.Primary)
        );

        const lobbyMsg = await message.channel.send({
            embeds: [rrmLobbyEmbed(host, lobby.players)],
            components: [joinRow]
        });

        lobby.lobbyMessage = lobbyMsg;

        lobby.lobbyTimer = setTimeout(async () => {
            const g = rrmGames.get(cid);
            if (!g || g.started) return;

            rrmGames.delete(cid);

            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("rrm_join").setLabel("✅ Join").setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId("rrm_start").setLabel("🚀 Start Game").setStyle(ButtonStyle.Primary).setDisabled(true)
            );
            lobbyMsg.edit({ embeds: [rrmLobbyEmbed(host, g.players, true)], components: [disabledRow] }).catch(() => { });

            await message.channel.send({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("⏰ The lobby expired — not enough players joined in time.")]
            });
        }, RRM_LOBBY_TIMEOUT_MS);

        return;
    }

    // ── .img <query> ───────────────────────────────────────────────────────
    if (trimmed.startsWith(`${PREFIX}img `)) {
        const query = trimmed.slice(PREFIX.length + 4).trim();
        if (!query) return message.reply("Usage: `.img <search term>`");

        if (cooldowns.has(message.author.id)) {
            const remaining = (cooldowns.get(message.author.id) + COOLDOWN_MS - Date.now()) / 1000;
            if (remaining > 0) return message.reply(`⏳ Slow down! Wait **${remaining.toFixed(1)}s**.`);
        }
        cooldowns.set(message.author.id, Date.now());

        const cacheKey = query.toLowerCase();
        if (cache[cacheKey] && (Date.now() - cache[cacheKey].ts < CACHE_TTL_MS)) {
            console.log(`[Cache Hit] Query: "${query}"`);
            return startImageSession(message, query, cache[cacheKey].results);
        }

        let ack = await message.reply("🔍 Searching Google Images via SerpAPI…");

        try {
            const response = await axios.get("https://serpapi.com/search", {
                params: {
                    engine: "google_images",
                    q: query,
                    api_key: process.env.SERP_API_KEY,
                    ijn: "0"
                }
            });

            const results = response.data.image_results;
            if (!results || results.length === 0) {
                return ack.edit("❌ No image results found for that query.");
            }

            const cleanResults = results.slice(0, RESULTS_PER_QUERY).map(img => ({
                title: img.title,
                url: img.original,
                source: img.link
            }));

            cache[cacheKey] = { ts: Date.now(), results: cleanResults };
            saveCache(cache);

            await ack.delete().catch(() => { });
            return startImageSession(message, query, cleanResults);
        } catch (error) {
            console.error("[Search Error]", error.response?.data || error.message);
            return ack.edit("❌ Error executing your image search operation.");
        }
    }
});

async function startImageSession(message, query, results) {
    const session = {
        images: results,
        index: 0,
        query,
        owner: message.author.id,
        timer: null,
        messageRef: null
    };

    const replyMsg = await message.channel.send({
        embeds: [buildImgEmbed(session)],
        components: [buildDynamicRow(session)]
    });

    session.messageRef = replyMsg;
    session.timer = scheduleSessionExpiry(replyMsg.id);
    sessions.set(replyMsg.id, session);
}

// ─── Interaction Router (Button Processing) ───────────────────────────────────

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    const mid = interaction.message.id;
    const cid = interaction.channelId;
    const uid = interaction.user.id;
    const customId = interaction.customId;

    // ── 1v1 Russian Roulette Buttons ──────────────────────────────────────────
    if (customId === "rr_accept" || customId === "rr_decline") {
        const game = rrGames.get(cid);
        if (!game || !game.pending) {
            return interaction.reply({ content: "❌ No pending challenge found in this channel.", ephemeral: true });
        }
        if (uid !== game.challenged) {
            return interaction.reply({ content: "❌ Only the challenged person can interact with this.", ephemeral: true });
        }

        clearRRChallengeTimeout(game);

        if (customId === "rr_decline") {
            rrGames.delete(cid);
            const declinedEmbed = new EmbedBuilder()
                .setColor(0x7289DA)
                .setDescription(`❌ **${game.names[game.challenged]}** backed out of the challenge. Chickened out! 🐔`);
            await interaction.update({ components: [] });
            return interaction.channel.send({ embeds: [declinedEmbed] });
        }

        game.pending = false;
        await interaction.update({ components: [] });

        const startEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("💥 Game Started — Gun is Loaded!")
            .setDescription(
                `**${game.names[game.challenged]}** accepted the duel!\n\n` +
                `Chamber: ${rrStatusBar(0)}\n\n` +
                `🎯 First turn goes to: <@${game.turn}>! Pull the trigger when ready.`
            );

        const gameMsg = await interaction.channel.send({ embeds: [startEmbed], components: [shootRow(false)] });
        game.gameMessage = gameMsg;
        scheduleRRTurnTimeout(cid, interaction.channel, interaction.guild);
        return;
    }

    if (customId === "rr_shoot") {
        const game = rrGames.get(cid);
        if (!game || game.pending) {
            return interaction.reply({ content: "❌ No game running right now.", ephemeral: true });
        }
        if (uid !== game.turn) {
            return interaction.reply({ content: "❌ Wait for your turn!", ephemeral: true });
        }

        clearRRTurnTimeout(game);
        await interaction.deferUpdate();

        const currentShotIndex = game.shotsOrder[game.shotsFired];
        const hitBullet = game.chamber[currentShotIndex];
        game.shotsFired++;

        if (hitBullet) {
            rrGames.delete(cid);
            game.gameMessage?.edit({ components: [shootRow(true)] }).catch(() => { });

            const deadName = game.names[uid];
            const winnerId = game.players.find(id => id !== uid);
            const winnerName = game.names[winnerId];

            const blowEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("💥 BANG! Game Over")
                .setDescription(
                    `Chamber: ${rrStatusBar(game.shotsFired)}\n\n` +
                    `💀 **${deadName}** blew their brains out on shot **${game.shotsFired}**!\n\n` +
                    `🏆 **${winnerName}** survives the encounter and wins!\n` +
                    `👢 Kicking **${deadName}** from the server...`
                )
                .setTimestamp();

            await interaction.channel.send({ embeds: [blowEmbed] });

            try {
                const victim = await interaction.guild.members.fetch(uid);
                await victim.kick("Lost a game of Russian Roulette 💀");
            } catch {
                await interaction.channel.send(`⚠️ Couldn't kick **${deadName}** — missing hierarchy permission structure.`);
            }
            return;
        }

        if (game.shotsFired >= RR_TOTAL_SHOTS) {
            rrGames.delete(cid);
            game.gameMessage?.edit({ components: [shootRow(true)] }).catch(() => { });
            return interaction.channel.send("🤷 somehow both of you survived... Gun malfunctioned or empty. Game voided.");
        }

        const nextTurn = game.players.find(id => id !== uid);
        game.turn = nextTurn;

        const liveEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(" Harrison click... *click* Safe!")
            .setDescription(
                `Chamber: ${rrStatusBar(game.shotsFired)}\n` +
                `Shots fired: **${game.shotsFired}/6**\n\n` +
                `👉 Next turn: <@${game.turn}>. Your choice with destiny!`
            );

        await game.gameMessage?.edit({ embeds: [liveEmbed], components: [shootRow(false)] });
        scheduleRRTurnTimeout(cid, interaction.channel, interaction.guild);
        return;
    }

    // ── Multiplayer Russian Roulette Buttons ─────────────────────────────────
    if (customId === "rrm_join") {
        const lobby = rrmGames.get(cid);
        if (!lobby || lobby.started) {
            return interaction.reply({ content: "❌ No open multi lobby found.", ephemeral: true });
        }
        if (lobby.players.some(p => p.id === uid)) {
            return interaction.reply({ content: "❌ Already registered inside this instance.", ephemeral: true });
        }
        if (lobby.players.length >= RRM_MAX_PLAYERS) {
            return interaction.reply({ content: "❌ Lobby is completely full.", ephemeral: true });
        }

        lobby.players.push({
            id: uid,
            name: interaction.member.displayName,
            member: interaction.member
        });

        return interaction.update({ embeds: [rrmLobbyEmbed(lobby.host, lobby.players)] });
    }

    if (customId === "rrm_start") {
        const lobby = rrmGames.get(cid);
        if (!lobby || lobby.started) {
            return interaction.reply({ content: "❌ No matching configurable session open.", ephemeral: true });
        }
        if (uid !== lobby.host.id) {
            return interaction.reply({ content: "❌ Only the host can manually force trigger a game start configuration match.", ephemeral: true });
        }
        if (lobby.players.length < 2) {
            return interaction.reply({ content: "❌ You need at least 2 players to start a multiplayer match.", ephemeral: true });
        }

        clearTimeout(lobby.lobbyTimer);
        lobby.started = true;

        const game = buildRRMGame(lobby.players);
        rrmGames.set(cid, game);

        await interaction.update({ components: [] });

        const startEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle(`🔫 Multiplayer Russian Roulette — Round ${game.round}`)
            .setDescription(
                `The multiplayer game has begun with **${game.players.length} players**!\n\n` +
                rrmPlayerList(game.players) + `\n\n` +
                `🍀 Revolver loaded with 1 live round.\n\n` +
                `🎯 First turn tracking: <@${game.turn.id}>! click below to continue.`
            );

        const gameMsg = await interaction.channel.send({ embeds: [startEmbed], components: [shootRow(false)] });
        game.gameMessage = gameMsg;
        scheduleRRMTurnTimeout(cid, interaction.channel, interaction.guild);
        return;
    }

    // Handle Multiplayer Shoot Actions
    if (customId === "rrm_shoot") {
        const game = rrmGames.get(cid);
        if (!game || !game.started) return; // session doesn't exist
        if (uid !== game.turn.id) {
            return interaction.reply({ content: "❌ Wait for your designated turn structure placement!", ephemeral: true });
        }

        clearRRMTurnTimeout(game);
        await interaction.deferUpdate();

        const currentShotIndex = game.shotsOrder[game.shotsFired];
        const hitBullet = game.chamber[currentShotIndex];
        game.shotsFired++;

        const currentShooter = game.turn;

        if (hitBullet) {
            game.gameMessage?.edit({ components: [shootRow(true)] }).catch(() => { });

            const deadEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("💥 BANG! Disqualified")
                .setDescription(
                    `Chamber: ${rrStatusBar(game.shotsFired)}\n\n` +
                    `💀 **${currentShooter.name}** triggered the live bullet round at shot frame index **${game.shotsFired}**!\n` +
                    `👢 Removing player structure config...`
                );

            await interaction.channel.send({ embeds: [deadEmbed] });

            try {
                await currentShooter.member.kick("Lost Multiplayer Russian Roulette 💀");
            } catch {
                await interaction.channel.send(`⚠️ Failed executing target kick sequence context on **${currentShooter.name}**.`);
            }

            await eliminateRRMPlayer(cid, interaction.channel, interaction.guild, currentShooter);
            return;
        }

        // Safe pull setup structure
        let nextTurnIndex = game.turnIndex + 1;
        let nextPlayer = null;

        while (nextTurnIndex < game.turnOrder.length) {
            const checkPlayer = game.turnOrder[nextTurnIndex];
            if (game.players.some(p => p.id === checkPlayer.id)) {
                game.turnIndex = nextTurnIndex;
                nextPlayer = checkPlayer;
                break;
            }
            nextTurnIndex++;
        }

        // Cycle complete condition checks
        if (!nextPlayer) {
            game.round++;
            freshRRMRound(game);

            const roundEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle(`🔄 Round ${game.round} Begins`)
                .setDescription(
                    `**${game.players.length} players** remain!\n\n` +
                    rrmPlayerList(game.players) + `\n\n` +
                    `Gun reloaded. 👉 First shooter target context: <@${game.turn.id}>`
                );

            const msg = await interaction.channel.send({ embeds: [roundEmbed], components: [shootRow(false)] });
            game.gameMessage = msg;
            scheduleRRMTurnTimeout(cid, interaction.channel, interaction.guild);
            return;
        }

        game.turn = nextPlayer;

        const nextEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("🔍 *Click*... Safe pass rule context.")
            .setDescription(
                `Chamber: ${rrStatusBar(game.shotsFired)}\n` +
                `Shots pulled: **${game.shotsFired}/6**\n\n` +
                `👉 Next turn slot tracking target: <@${game.turn.id}>.`
            );

        await game.gameMessage?.edit({ embeds: [nextEmbed], components: [shootRow(false)] });
        scheduleRRMTurnTimeout(cid, interaction.channel, interaction.guild);
        return;
    }

    // ── Image Session Browser Navigation Engine ────────────────────────────────
    const session = sessions.get(mid);
    if (!session) return;

    if (uid !== session.owner) {
        return interaction.reply({ content: "❌ You are not the owner running this display image search pipeline.", ephemeral: true });
    }

    clearTimeout(session.timer);

    if (customId === "delete") {
        sessions.delete(mid);
        return interaction.message.delete().catch(() => { });
    }

    if (customId === "download") {
        await interaction.reply({ content: `💾 **Download Link:** [Click here to view original asset source](${session.images[session.index].url})`, ephemeral: true });
        session.timer = scheduleSessionExpiry(mid);
        return;
    }

    if (customId === "prev") {
        session.index = (session.index - 1 + session.images.length) % session.images.length;
    } else if (customId === "next") {
        session.index = (session.index + 1) % session.images.length;
    }

    await interaction.update({
        embeds: [buildImgEmbed(session)],
        components: [buildDynamicRow(session)]
    });

    session.timer = scheduleSessionExpiry(mid);
});

// Log inside Gateway client channel matrix connection hook
client.login(process.env.DISCORD_TOKEN);