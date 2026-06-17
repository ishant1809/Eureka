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
const RR_CHALLENGE_TIMEOUT_MS = 30_000;     // 30 seconds to accept/decline a challenge
const RR_TURN_TIMEOUT_MS = 90_000;          // 90 seconds to pull the trigger before AFK kick
const RRM_LOBBY_TIMEOUT_MS = 45_000;        // 45 seconds to fill the multiplayer lobby
const RRM_MAX_PLAYERS = 6;

// ─── Startup Validation ───────────────────────────────────────────────────────

// UPDATED: Added GEMINI_API_KEY to required variables
const REQUIRED_ENV = ["DISCORD_TOKEN", "SERVER_ID", "SERP_API_KEY", "GEMINI_API_KEY"];
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
        if (key === "smTriggers") continue; // Prevent SM triggers from expiring
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
if (!cache.smTriggers) cache.smTriggers = {}; // Initialize SM triggers store
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
            `rrmPlayerList(players)`
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

    // ─── SM Trigger Listener ───────────────────────────────────────────────
    for (const [userId, triggerText] of Object.entries(cache.smTriggers || {})) {
        if (message.author.id === userId) continue;

        if (lower.includes(triggerText)) {
            try {
                // Fetch the last 10 messages ending with this one
                const fetchedMessages = await message.channel.messages.fetch({ limit: 10 });
                const messagesArray = Array.from(fetchedMessages.values()).reverse();

                const contextText = messagesArray.map(m => `**${m.author.username}**: ${truncate(m.content || "[Attachment/Embed]", 200)}`).join('\n');

                const dmEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`🔔 Mention Triggered: "${triggerText}"`)
                    .setDescription(`Your trigger was mentioned in <#${message.channel.id}> by **${message.author.username}**.\n\n**Context (Last 10 messages):**\n${contextText}`)
                    .addFields({ name: "🔗 Jump to Message", value: `[Click Here](${message.url})` })
                    .setTimestamp();

                const user = await client.users.fetch(userId);
                await user.send({ embeds: [dmEmbed] });
            } catch (err) {
                console.error(`[SM] Failed to send DM to ${userId}:`, err.message);
            }
        }
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
                { name: "🤖 `.ai <prompt>`", value: "Ask Google Gemini AI a question and get a response.", inline: false }, // UPDATED: Added help listing
                { name: "🖼️ `.img <query>`", value: "Search Google Images and browse with buttons. ⬅ ➡ navigate, 🔗 source, 💾 download, 🗑 remove.", inline: false },
                { name: "📡 `.usage`", value: "Check SerpAPI quota and monthly usage.", inline: false },
                { name: "🗑️ `.snipe`", value: "Show the **last deleted message** in this channel.", inline: false },
                { name: "📜 `.msnipe`", value: "Show the last **up to 25 deleted messages** in this channel.", inline: false },
                { name: "✏️ `.esnipe`", value: "Show the **last edited message** in this channel with before/after diff.", inline: false },
                { name: "🔔 `.sm <text>`", value: "Setmention. Set a mention text; you'll receive a DM with 10 previous messages whenever this text is sent.", inline: false },
                { name: "🔕 `.sm clear`", value: "Clear your active setmention trigger.", inline: false },
                { name: "🔫 `.rr @user`", value: "Challenge someone to 1v1 Russian Roulette — 6 chambers, 1 bullet, random pull order. Loser gets kicked.", inline: false },
                { name: "🔫 `.rrm`", value: "Open a **multiplayer** Russian Roulette lobby (2–6 players). Click ✅ Join to enter, host clicks 🚀 Start. One player is eliminated each round — last alive wins!", inline: false },
                { name: "✅ Accept / ❌ Decline", value: "Use the buttons on a `.rr` challenge message to accept or back down.", inline: false },
                { name: "💥 Pull the Trigger", value: "Click the **🔫 Pull the Trigger** button when it's your turn.", inline: false }
            )
            .setFooter({ text: "All snipe commands are channel-specific." })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    }

    // ── .ai ────────────────────────────────────────────────────────────────
    // NEW: .ai execution logic blocks
    // ── .ai ────────────────────────────────────────────────────────────────
    if (lower.startsWith(`${PREFIX}ai `)) {
        const prompt = trimmed.slice(PREFIX.length + 3).trim();
        if (!prompt) {
            return message.reply(`❌ Provide a prompt. Usage: \`${PREFIX}ai <your question>\``);
        }

        let ack;
        try {
            ack = await message.reply("🤖 *Gemini is thinking...*");
        } catch (e) {
            console.error("[AI] Error sending acknowledgment message:", e.message);
            return;
        }

        try {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
                {
                    // Adding a structural constraint to the text prompt to force medium length
                    contents: [{ parts: [{ text: `${prompt} (Keep your response concise and medium-length.)` }] }]
                },
                {
                    headers: { "Content-Type": "application/json" }
                }
            );

            const aiReply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!aiReply) {
                return ack.edit("❌ Received an empty response from Gemini.");
            }

            // Create the gray box (Embed)
            const aiEmbed = new EmbedBuilder()
                .setColor(0x2F3136) // Sleek dark grey color
                .setAuthor({ name: "Gemini AI", iconURL: client.user.displayAvatarURL() })
                .setDescription(truncate(aiReply, 4000)) // Keeps it safe within Discord limits
                .setTimestamp();

            // Remove the "thinking..." text and reply with the clean embed box
            await ack.delete().catch(() => { });
            return message.reply({ embeds: [aiEmbed] });

        } catch (error) {
            console.error("[AI] API execution failed:", error.response?.data || error.message);
            
            const status = error.response?.status;
            if (status === 429 || status === 503) {
                return ack.edit("🐌 **High Demand!** The AI is currently experiencing heavy traffic or you're asking too fast. Please slow down and try again in a moment.");
            }

            return ack.edit("❌ An error occurred while generating text via Google Gemini AI.");
        }
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
});

client.login(process.env.DISCORD_TOKEN);