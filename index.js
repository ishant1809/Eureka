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
    ButtonStyle
} = require("discord.js");

// ─── Constants ────────────────────────────────────────────────────────────────

const PREFIX = ".";
const CACHE_FILE = path.join(__dirname, "cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SESSION_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const COOLDOWN_MS = 3_000;                  // 3 seconds per user
const RESULTS_PER_QUERY = 20;
const RR_CHALLENGE_TIMEOUT_MS = 30_000;     // 30 seconds to accept/decline a challenge
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
        GatewayIntentBits.MessageContent
    ]
});

client.once("clientReady", () => {
    console.log(`[Ready] Logged in as ${client.user.tag}`);
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

/** Load a fresh gun and shuffle a new turn order for surviving players */
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

/**
 * Remove a player after elimination.
 * Checks win condition, then advances the turn or starts a new round.
 */
async function eliminateRRMPlayer(cid, channel, guild, eliminated) {
    const game = rrmGames.get(cid);
    if (!game) return;

    clearRRMTurnTimeout(game);

    game.players = game.players.filter(p => p.id !== eliminated.id);
    game.eliminated.push(eliminated);

    // ── Win condition ──────────────────────────────────────────────────────
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

    // ── Find next alive player in current round's turn order ───────────────
    let nextTurn = null;
    for (let i = game.turnIndex + 1; i < game.turnOrder.length; i++) {
        if (game.players.find(p => p.id === game.turnOrder[i].id)) {
            game.turnIndex = i;
            nextTurn = game.turnOrder[i];
            break;
        }
    }

    if (!nextTurn) {
        // Everyone in the turn order has shot — start next round
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

function buildEmbed(session) {
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
                { name: "🖼️ `.img <query>`", value: "Search Google Images and browse with buttons. ⬅ ➡ navigate, 🔗 source, 💾 download, 🗑 remove.", inline: false },
                { name: "📡 `.usage`", value: "Check SerpAPI quota and monthly usage.", inline: false },
                { name: "🗑️ `.snipe`", value: "Show the **last deleted message** in this channel.", inline: false },
                { name: "📜 `.msnipe`", value: "Show the last **up to 25 deleted messages** in this channel.", inline: false },
                { name: "✏️ `.esnipe`", value: "Show the **last edited message** in this channel with before/after diff.", inline: false },
                { name: "🔫 `.rr @user`", value: "Challenge someone to 1v1 Russian Roulette — 6 chambers, 1 bullet, random pull order. Loser gets kicked.", inline: false },
                { name: "🔫 `.rrm`", value: "Open a **multiplayer** Russian Roulette lobby (2–6 players). Click ✅ Join to enter, host clicks 🚀 Start. One player is eliminated each round — last alive wins!", inline: false },
                { name: "✅ Accept / ❌ Decline", value: "Use the buttons on a `.rr` challenge message to accept or back down.", inline: false },
                { name: "💥 Pull the Trigger", value: "Click the **🔫 Pull the Trigger** button when it's your turn.", inline: false }
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
                `> 🎲 The chambers are pulled in a **random order** — you won't know when it's coming\n` +
                `> 💥 Each player takes turns — whoever gets the bullet is **kicked from the server**\n` +
                `> ⚠️ **Copy your server invite link before accepting!**\n\n` +
                `**${target.displayName}**, do you accept the challenge?`
            )
            .setFooter({ text: "6 chambers • 1 bullet • random order • may the odds be with you" })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rr_accept").setLabel("✅ Accept").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("rr_decline").setLabel("❌ Decline").setStyle(ButtonStyle.Secondary)
        );

        const challengeMsg = await message.channel.send({ embeds: [embed], components: [row] });
        scheduleRRChallengeTimeout(cid, message.channel, challengeMsg);
        return;
    }

    // ── .rrm — Multiplayer Russian Roulette ────────────────────────────────
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
            new ButtonBuilder()
                .setCustomId("rrm_join")
                .setLabel("✅ Join")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("rrm_start")
                .setLabel("🚀 Start Game")
                .setStyle(ButtonStyle.Primary)
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
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setDescription("⏰ The lobby expired — not enough players joined in time.")
                ]
            });
        }, RRM_LOBBY_TIMEOUT_MS);

        return;
    }

    // ── .img <query> ───────────────────────────────────────────────────────
    if (trimmed.startsWith(`${PREFIX}img `)) {
        const query = trimmed.slice(PREFIX.length + 4).trim();
        if (!query) return message.reply(`Usage: \`${PREFIX}img <search term>\``);

        const now = Date.now();
        const lastUsed = cooldowns.get(message.author.id) ?? 0;
        const remaining = COOLDOWN_MS - (now - lastUsed);

        if (remaining > 0) {
            return message.reply(
                `⏳ Slow down! Wait **${(remaining / 1000).toFixed(1)}s** before searching again.`
            );
        }

        cooldowns.set(message.author.id, now);

        const cacheKey = query.toLowerCase();
        const cached = cache[cacheKey];
        const cacheHit = cached && (now - cached.ts) < CACHE_TTL_MS;

        let images;
        let searchTimeMs = 0;

        if (cacheHit) {
            images = cached.images;
            console.log(`[Cache] HIT for "${query}"`);
        } else {
            const fetchStart = Date.now();
            try {
                const [, response] = await Promise.all([
                    message.channel.sendTyping(),
                    axios.get("https://serpapi.com/search.json", {
                        params: {
                            engine: "google_images",
                            q: query,
                            api_key: process.env.SERP_API_KEY
                        }
                    })
                ]);

                const results = response.data.images_results;
                if (!results || results.length === 0) return message.reply("❌ No images found for that query.");

                images = results
                    .slice(0, RESULTS_PER_QUERY)
                    .filter(img => img.original && img.original.startsWith("http"))
                    .map(img => ({
                        url: img.original,
                        title: img.title || query,
                        source: img.link || img.original
                    }));

                searchTimeMs = Date.now() - fetchStart;
                cache[cacheKey] = { ts: now, images };
                saveCache(cache);
                console.log(`[Cache] MISS — fetched "${query}" in ${searchTimeMs}ms`);

            } catch (error) {
                console.error("[Error] SerpAPI:", error.response?.data || error.message);
                return message.reply("❌ Search failed. Check the API key or try again later.");
            }
        }

        if (!images || images.length === 0) {
            return message.reply("❌ No usable images found (all results had invalid URLs).");
        }

        const session = {
            images,
            index: 0,
            query,
            owner: message.author.id,
            messageRef: null
        };

        const embed = buildEmbed(session);
        const row = buildDynamicRow(session);
        const timingNote = cacheHit ? "*(cached)*" : `*(fetched in ${searchTimeMs}ms)*`;

        const sentMessage = await message.channel.send({
            content: `🔍 Results for **${query}** ${timingNote}`,
            embeds: [embed],
            components: [row]
        });

        session.messageRef = sentMessage;
        session.timer = scheduleSessionExpiry(sentMessage.id);
        sessions.set(sentMessage.id, session);
    }
});

// ─── Interaction (Button) Handler ─────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    const cid = interaction.channel.id;

    // ══ Multiplayer RR Buttons ════════════════════════════════════════════════

    // ── RRM: Join ──────────────────────────────────────────────────────────
    if (interaction.customId === "rrm_join") {
        const lobby = rrmGames.get(cid);
        if (!lobby || lobby.started) return interaction.reply({ content: "❌ No open lobby here.", ephemeral: true });

        if (lobby.players.find(p => p.id === interaction.user.id)) {
            return interaction.reply({ content: "❌ You're already in the lobby.", ephemeral: true });
        }
        if (lobby.players.length >= RRM_MAX_PLAYERS) {
            return interaction.reply({ content: `❌ Lobby is full (${RRM_MAX_PLAYERS} players max).`, ephemeral: true });
        }

        lobby.players.push({
            id: interaction.user.id,
            name: interaction.member.displayName,
            member: interaction.member
        });

        const isFull = lobby.players.length >= RRM_MAX_PLAYERS;
        const joinRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rrm_join").setLabel("✅ Join").setStyle(ButtonStyle.Success).setDisabled(isFull),
            new ButtonBuilder().setCustomId("rrm_start").setLabel("🚀 Start Game").setStyle(ButtonStyle.Primary)
        );

        return interaction.update({
            embeds: [rrmLobbyEmbed(lobby.host, lobby.players)],
            components: [joinRow]
        });
    }

    // ── RRM: Force Start ───────────────────────────────────────────────────
    if (interaction.customId === "rrm_start") {
        const lobby = rrmGames.get(cid);
        if (!lobby || lobby.started) return interaction.reply({ content: "❌ No open lobby here.", ephemeral: true });
        if (interaction.user.id !== lobby.host.id) {
            return interaction.reply({ content: "❌ Only the host can start the game.", ephemeral: true });
        }
        if (lobby.players.length < 2) {
            return interaction.reply({ content: "❌ Need at least **2 players** to start.", ephemeral: true });
        }

        clearTimeout(lobby.lobbyTimer);
        lobby.started = true;

        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rrm_join").setLabel("✅ Join").setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId("rrm_start").setLabel("🚀 Start Game").setStyle(ButtonStyle.Primary).setDisabled(true)
        );
        await interaction.update({ embeds: [rrmLobbyEmbed(lobby.host, lobby.players, true)], components: [disabledRow] });

        const game = buildRRMGame(lobby.players);
        rrmGames.set(cid, game);

        // DM invite links to all players
        try {
            const invite = await interaction.channel.createInvite({
                maxAge: 3600,
                maxUses: game.players.length + 2,
                reason: "RRM safety net invite"
            });

            const dmEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("🔫 Multiplayer Russian Roulette — Your Safety Net")
                .setDescription(
                    `The multiplayer game in **${interaction.guild.name}** is starting!\n\n` +
                    `> ⚠️ If you're eliminated, you'll be **kicked** from the server.\n` +
                    `> 🔗 Save this invite link to rejoin:\n\n` +
                    `**${invite.url}**`
                )
                .setFooter({ text: "Link expires in 1 hour" })
                .setTimestamp();

            const dmResults = await Promise.allSettled(
                game.players.map(p => p.member.user.send({ embeds: [dmEmbed] }))
            );

            const dmFailed = game.players
                .filter((_, i) => dmResults[i].status === "rejected")
                .map(p => p.name);

            if (dmFailed.length > 0) {
                await interaction.channel.send(
                    `⚠️ Couldn't DM **${dmFailed.join(", ")}** — they should copy a server invite manually before playing!`
                );
            }
        } catch {
            await interaction.channel.send("⚠️ Couldn't generate an invite link — check my `Create Instant Invite` permission.");
        }

        const startEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🔫 Multiplayer Russian Roulette — Game On!")
            .setDescription(
                `**${game.players.length} players** enter. **1** survives.\n\n` +
                `**Players:**\n` +
                rrmPlayerList(game.players) + `\n\n` +
                `🎲 Turn order randomised!\n` +
                `<@${game.turn.id}> pulls first — good luck! 🤞`
            )
            .setFooter({ text: `Round 1 • ${game.players.length} players • 1 bullet per round • random pull order` })
            .setTimestamp();

        const gameMsg = await interaction.channel.send({ embeds: [startEmbed], components: [shootRow(false)] });
        game.gameMessage = gameMsg;

        scheduleRRMTurnTimeout(cid, interaction.channel, interaction.guild);
        return;
    }

    // ══ Regular RR Buttons ════════════════════════════════════════════════════

    // ── Accept ─────────────────────────────────────────────────────────────
    if (interaction.customId === "rr_accept") {
        const game = rrGames.get(cid);
        if (!game || !game.pending) return interaction.reply({ content: "❌ No pending challenge here.", ephemeral: true });
        if (interaction.user.id !== game.challenged) return interaction.reply({ content: "❌ This challenge isn't for you.", ephemeral: true });

        game.pending = false;
        clearRRChallengeTimeout(game);
        const firstName = game.names[game.turn];

        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rr_accept").setLabel("✅ Accept").setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId("rr_decline").setLabel("❌ Decline").setStyle(ButtonStyle.Secondary).setDisabled(true)
        );
        await interaction.update({ components: [disabledRow] });

        const startEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🔫 Russian Roulette — Game Started!")
            .setDescription(
                `**${game.names[game.challenged]}** accepted the challenge!\n\n` +
                `🎲 Coin flip says — **${firstName}** goes first!\n\n` +
                `Chamber: ${rrStatusBar(0)}\n` +
                `Shots fired: **0/${RR_TOTAL_SHOTS}**\n\n` +
                `<@${game.turn}> — press the button below when you're ready. 🤞`
            )
            .setFooter({ text: "6 chambers • 1 bullet • random pull order • good luck" })
            .setTimestamp();

        const gameMsg = await interaction.channel.send({ embeds: [startEmbed], components: [shootRow(false)] });
        game.gameMessage = gameMsg;

        scheduleRRTurnTimeout(cid, interaction.channel, interaction.guild);

        try {
            const invite = await interaction.channel.createInvite({ maxAge: 3600, maxUses: 2, reason: "Russian Roulette safety net invite" });

            const dmEmbed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle("🔫 Russian Roulette — Your Safety Net")
                .setDescription(
                    `A game of Russian Roulette has started in **${interaction.guild.name}**!\n\n` +
                    `> ⚠️ If you lose, you'll be **kicked** from the server.\n` +
                    `> 🔗 Here's your personal invite link to rejoin — **save it now!**\n\n` +
                    `**${invite.url}**`
                )
                .setFooter({ text: "Link expires in 1 hour • 2 uses max" })
                .setTimestamp();

            const challengerMember = await interaction.guild.members.fetch(game.challenger);
            const challengedMember = await interaction.guild.members.fetch(game.challenged);

            const dmResults = await Promise.allSettled([
                challengerMember.user.send({ embeds: [dmEmbed] }),
                challengedMember.user.send({ embeds: [dmEmbed] })
            ]);

            const dmFailed = [];
            if (dmResults[0].status === "rejected") dmFailed.push(game.names[game.challenger]);
            if (dmResults[1].status === "rejected") dmFailed.push(game.names[game.challenged]);

            if (dmFailed.length > 0) {
                await interaction.channel.send(
                    `⚠️ Couldn't DM the invite link to **${dmFailed.join(" and ")}** — their DMs may be closed. ` +
                    `They should copy a server invite manually before playing!`
                );
            }
        } catch (err) {
            console.error("RR invite DM error:", err);
            await interaction.channel.send("⚠️ Couldn't generate an invite link — make sure I have the `Create Instant Invite` permission.");
        }

        return;
    }

    // ── Decline ────────────────────────────────────────────────────────────
    if (interaction.customId === "rr_decline") {
        const game = rrGames.get(cid);
        if (!game || !game.pending) return interaction.reply({ content: "❌ No pending challenge here.", ephemeral: true });
        if (interaction.user.id !== game.challenged) return interaction.reply({ content: "❌ This challenge isn't for you.", ephemeral: true });

        clearRRChallengeTimeout(rrGames.get(cid));
        rrGames.delete(cid);

        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rr_accept").setLabel("✅ Accept").setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId("rr_decline").setLabel("❌ Decline").setStyle(ButtonStyle.Secondary).setDisabled(true)
        );
        await interaction.update({ components: [disabledRow] });

        return interaction.channel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x57F287)
                    .setDescription(`🏳️ **${interaction.member.displayName}** backed down from the challenge. Smart move.`)
            ]
        });
    }

    // ── Shoot (handles BOTH .rr and .rrm) ─────────────────────────────────
    if (interaction.customId === "rr_shoot") {

        // ── Check for active RRM game first ───────────────────────────────
        const rrmGame = rrmGames.get(cid);
        if (rrmGame && Array.isArray(rrmGame.eliminated)) {
            // eliminated array only exists on live games, not lobbies
            // It's a live RRM game (has .eliminated — not a lobby)
            if (interaction.user.id !== rrmGame.turn.id) {
                return interaction.reply({
                    content: `⏳ It's not your turn! Wait for <@${rrmGame.turn.id}> to pull the trigger.`,
                    ephemeral: true
                });
            }

            await interaction.update({ components: [shootRow(true)] });

            const chamberSlot = rrmGame.shotsOrder[rrmGame.shotsFired];
            const bullet = rrmGame.chamber[chamberSlot];
            rrmGame.shotsFired++;
            rrmGame.turnIndex = rrmGame.turnOrder.findIndex(p => p.id === rrmGame.turn.id);

            if (bullet) {
                const loser = rrmGame.turn;

                const deathEmbed = new EmbedBuilder()
                    .setColor(0x2B2D31)
                    .setTitle("💀 BANG! Someone's out.")
                    .setDescription(
                        `Chamber: ${rrStatusBar(rrmGame.shotsFired - 1)} 💥\n\n` +
                        `**${loser.name}** pulled the trigger and...\n` +
                        `> ***BANG!*** The bullet was waiting. 🔴\n\n` +
                        `💀 **${loser.name}** is eliminated!\n` +
                        `👢 Kicking them from the server...`
                    )
                    .setFooter({ text: `Round ${rrmGame.round} • ${rrmGame.players.length - 1} players remaining` })
                    .setTimestamp();

                await interaction.channel.send({ embeds: [deathEmbed] });
                await interaction.channel.send(`😂🤣 **${loser.name}** just got clapped in multiplayer RR lmaooo 💀🔫`);

                try {
                    await interaction.member.kick("Eliminated in Multiplayer Russian Roulette 🔫");
                } catch {
                    await interaction.channel.send(`⚠️ Couldn't kick **${loser.name}** — missing permission or they outrank me.`);
                }

                await eliminateRRMPlayer(cid, interaction.channel, interaction.guild, loser);
                return;
            }

            // *click* — survived. Find next alive player in turn order.
            const survived = rrmGame.turn;
            let nextTurn = null;

            for (let i = rrmGame.turnIndex + 1; i < rrmGame.turnOrder.length; i++) {
                if (rrmGame.players.find(p => p.id === rrmGame.turnOrder[i].id)) {
                    rrmGame.turnIndex = i;
                    nextTurn = rrmGame.turnOrder[i];
                    break;
                }
            }

            if (!nextTurn) {
                // All alive players have shot this round — nobody died, new round
                rrmGame.round++;
                freshRRMRound(rrmGame);

                const nextRoundEmbed = new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle(`🔄 Round ${rrmGame.round} — Nobody Died!`)
                    .setDescription(
                        `All **${rrmGame.players.length}** players survived that round. The bullet was a dud!\n\n` +
                        `🔁 Reloading with a fresh bullet...\n\n` +
                        rrmPlayerList(rrmGame.players) + `\n\n` +
                        `<@${rrmGame.turn.id}> goes first this round!`
                    )
                    .setTimestamp();

                const gameMsg = await interaction.channel.send({ embeds: [nextRoundEmbed], components: [shootRow(false)] });
                rrmGame.gameMessage = gameMsg;
                scheduleRRMTurnTimeout(cid, interaction.channel, interaction.guild);
                return;
            }

            rrmGame.turn = nextTurn;

            const clickEmbed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle("*click* — Empty chamber.")
                .setDescription(
                    `Chamber: ${rrStatusBar(rrmGame.shotsFired)}\n` +
                    `Shots fired this round: **${rrmGame.shotsFired}**\n\n` +
                    `**${survived.name}** survived this pull. 😮‍💨\n\n` +
                    `<@${nextTurn.id}> — your turn! 🔫`
                )
                .setFooter({ text: `Round ${rrmGame.round} • ${rrmGame.players.length} still alive` })
                .setTimestamp();

            const gameMsg = await interaction.channel.send({ embeds: [clickEmbed], components: [shootRow(false)] });
            rrmGame.gameMessage = gameMsg;
            scheduleRRMTurnTimeout(cid, interaction.channel, interaction.guild);
            return;
        }

        // ── Regular 1v1 RR shoot ───────────────────────────────────────────
        const game = rrGames.get(cid);
        if (!game || game.pending) return interaction.reply({ content: "❌ No active game here.", ephemeral: true });
        if (interaction.user.id !== game.turn) {
            return interaction.reply({
                content: `⏳ It's not your turn! Wait for <@${game.turn}> to pull the trigger.`,
                ephemeral: true
            });
        }

        await interaction.update({ components: [shootRow(true)] });

        const chamberSlot = game.shotsOrder[game.shotsFired];
        const bullet = game.chamber[chamberSlot];
        game.shotsFired++;

        const currentIndex = game.players.indexOf(game.turn);
        const nextPlayer = game.players[currentIndex === 0 ? 1 : 0];

        if (bullet) {
            clearRRTurnTimeout(game);
            rrGames.delete(cid);

            const loser = interaction.member;
            const winner = interaction.guild.members.cache.get(nextPlayer);

            const deathEmbed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setTitle("💀 BANG! The bullet found its victim.")
                .setDescription(
                    `Chamber: ${rrStatusBar(game.shotsFired - 1)} 💥\n` +
                    `Shots fired: **${game.shotsFired}/${RR_TOTAL_SHOTS}**\n\n` +
                    `**${loser.displayName}** pulled the trigger and...\n` +
                    `> ***BANG!*** The chamber was loaded. 🔴\n\n` +
                    `🏆 **${winner ? winner.displayName : "The other player"}** survives and wins!\n\n` +
                    `👢 Kicking **${loser.displayName}** from the server...`
                )
                .setFooter({ text: "Should've copied that invite link." })
                .setTimestamp();

            await interaction.channel.send({ embeds: [deathEmbed] });
            await interaction.channel.send(`😂🤣😂 **${loser.displayName}** just got kicked for losing Russian Roulette lmaooo 💀🔫😂🤣😂`);

            try {
                await loser.kick("Lost a game of Russian Roulette 🔫");
            } catch {
                await interaction.channel.send(`⚠️ Couldn't kick **${loser.displayName}** — missing \`Kick Members\` permission or they outrank me.`);
            }

            return;
        }

        if (game.shotsFired >= RR_TOTAL_SHOTS) {
            clearRRTurnTimeout(game);
            rrGames.delete(cid);
            return interaction.channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x57F287)
                        .setTitle("🎉 Everyone Survived!")
                        .setDescription(
                            `Chamber: ${rrStatusBar(RR_TOTAL_SHOTS)}\n\n` +
                            `All 6 shots fired and **nobody died**. The bullet must've been a dud.\n` +
                            `Both players walk away alive. Remarkable.`
                        )
                        .setTimestamp()
                ]
            });
        }

        game.turn = nextPlayer;

        const survivedEmbed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle("*click* — Empty chamber.")
            .setDescription(
                `Chamber: ${rrStatusBar(game.shotsFired)}\n` +
                `Shots fired: **${game.shotsFired}/${RR_TOTAL_SHOTS}**\n\n` +
                `**${interaction.member.displayName}** pulled the trigger...\n` +
                `> *click* — Nothing. They live. 😮‍💨\n\n` +
                `<@${nextPlayer}> — your turn. Press the button below. 🔫`
            )
            .setFooter({ text: `${RR_TOTAL_SHOTS - game.shotsFired} shots remaining` })
            .setTimestamp();

        const newMsg = await interaction.channel.send({ embeds: [survivedEmbed], components: [shootRow(false)] });
        game.gameMessage = newMsg;
        scheduleRRTurnTimeout(cid, interaction.channel, interaction.guild);
        return;
    }

    // ══ Image Search Buttons ══════════════════════════════════════════════════

    const session = sessions.get(interaction.message.id);

    if (!session) {
        return interaction.reply({ content: "❌ This session has expired. Run the search again.", ephemeral: true });
    }

    if (interaction.customId === "download") {
        return interaction.reply({ content: `💾 **Direct URL:**\n${session.images[session.index].url}`, ephemeral: true });
    }

    if (interaction.customId === "delete") {
        if (interaction.user.id !== session.owner) {
            return interaction.reply({ content: "❌ Only the person who ran this search can delete it.", ephemeral: true });
        }
        clearTimeout(session.timer);
        sessions.delete(interaction.message.id);
        await interaction.deferUpdate();
        return interaction.message.delete();
    }

    if (interaction.customId === "next" || interaction.customId === "prev") {
        if (interaction.user.id !== session.owner) {
            return interaction.reply({ content: "❌ Only the person who ran this search can navigate results.", ephemeral: true });
        }

        if (interaction.customId === "next") {
            session.index = (session.index + 1) % session.images.length;
        } else {
            session.index = (session.index - 1 + session.images.length) % session.images.length;
        }

        sessions.set(interaction.message.id, session);

        return interaction.update({
            embeds: [buildEmbed(session)],
            components: [buildDynamicRow(session)]
        });
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);