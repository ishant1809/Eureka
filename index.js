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
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const SESSION_TTL_MS = 10 * 60 * 1000;          // 10 minutes
const COOLDOWN_MS = 3_000;                   // 3 seconds per user
const RESULTS_PER_QUERY = 20;

// ─── Startup Validation ───────────────────────────────────────────────────────

const REQUIRED_ENV = ["DISCORD_TOKEN", "SERVER_ID", "SERP_API_KEY"];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`[FATAL] Missing environment variable: ${key}`);
        process.exit(1);
    }
}

// ─── Cache (Persistent) ───────────────────────────────────────────────────────

/**
 * cache.json shape:
 * {
 *   "<query>": {
 *     "ts": <epoch ms>,
 *     "images": [ { url, title, source } ]
 *   }
 * }
 */

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

// Run auto-cleanup every hour
setInterval(() => pruneCache(cache), 60 * 60 * 1000);

// ─── In-Memory State ──────────────────────────────────────────────────────────

/** sessions: Map<messageId, { images, index, query, owner, timer }> */
const sessions = new Map();

/** cooldowns: Map<userId, lastUsedTimestamp> */
const cooldowns = new Map();

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildEmbed(session) {
    const img = session.images[session.index];
    return new EmbedBuilder()
        .setTitle(truncate(img.title, 256))
        .setDescription(`Image ${session.index + 1} / ${session.images.length}`)
        .setImage(img.url)
        .setFooter({ text: `Search: ${session.query}` });
}

function buildRow() {
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
            .setCustomId("source")
            .setLabel("🔗 Source")
            .setStyle(ButtonStyle.Link)
            .setURL("https://images.google.com"),   // placeholder; overridden per-session below
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

/**
 * Builds an action row with the correct Source URL for the current image.
 * Discord requires Link buttons to have a real URL at send-time, so we
 * rebuild the row whenever the index changes.
 */
function buildDynamicRow(session) {
    const img = session.images[session.index];
    const sourceUrl = img.source || img.url;   // fall back to direct URL

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

/** Ensure URL is valid for Discord (must start with http/https) */
function validUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol === "http:" || u.protocol === "https:") return url;
    } catch { }
    return "https://images.google.com";
}

function truncate(str, max) {
    if (!str) return "Untitled";
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function scheduleSessionExpiry(messageId) {
    const timer = setTimeout(() => {
        const session = sessions.get(messageId);
        if (!session) return;
        sessions.delete(messageId);
        // Silently remove buttons by editing the message
        session.messageRef?.edit({ components: [] }).catch(() => { });
        console.log(`[Session] Expired: ${messageId}`);
    }, SESSION_TTL_MS);
    return timer;
}

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {

    if (message.author.bot) return;
    if (message.guild?.id !== process.env.SERVER_ID) return;

    // ── .ping ──────────────────────────────────────────────────────────────────
    if (message.content === `${PREFIX}ping`) {

        const apiPing = client.ws.ping;
        const start = Date.now();
        const sent = await message.reply("🏓 Pinging…");
        const rtt = Date.now() - start;

        const bar = (ms) => {
            if (ms < 100) return "🟢";
            if (ms < 250) return "🟡";
            return "🔴";
        };

        return sent.edit(
            `🏓 **Pong!**\n` +
            `${bar(rtt)}  Message RTT: **${rtt}ms**\n` +
            `${bar(apiPing)}  API Ping:     **${apiPing}ms**`
        );
    }

    // ── .help ──────────────────────────────────────────────────────────────────
    if (message.content === `${PREFIX}help`) {
        return message.reply(
            "**Commands**\n" +
            `\`${PREFIX}img <query>\` — Search Google Images\n` +
            `\`${PREFIX}usage\` — SerpAPI quota and usage\n` +
            `\`${PREFIX}ping\` — Check bot latency\n` +
            `\`${PREFIX}help\` — Show this message`
        );
    }

    // ── .usage ─────────────────────────────────────────────────────────────────
    if (message.content.trim() === `${PREFIX}usage`) {

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

            console.log("[Usage] Response:", JSON.stringify(data));

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

    // ── @mention ───────────────────────────────────────────────────────────────
    if (message.mentions.users.has(client.user.id) && !message.content.startsWith(PREFIX) && !message.reference) {

        const apiPing = client.ws.ping;
        const start = Date.now();
        const sent = await message.reply(
            `👋 Hey! Use \`${PREFIX}img <query>\` to search images.\n🏓 Pinging…`
        );
        const rtt = Date.now() - start;

        const bar = (ms) => ms < 100 ? "🟢" : ms < 250 ? "🟡" : "🔴";

        return sent.edit(
            `👋 Hey! Use \`${PREFIX}img <query>\` to search for images.\n\n` +
            `${bar(rtt)}  Message RTT: **${rtt}ms**\n` +
            `${bar(apiPing)}  API Ping:     **${apiPing}ms**`
        );
    }

    // ── .img <query> ───────────────────────────────────────────────────────────
    if (message.content.startsWith(`${PREFIX}img `)) {

        const query = message.content.slice(PREFIX.length + 4).trim();

        if (!query) {
            return message.reply(`Usage: \`${PREFIX}img <search term>\``);
        }

        // ── Cooldown check ──────────────────────────────────────────────────
        const now = Date.now();
        const lastUsed = cooldowns.get(message.author.id) ?? 0;
        const remaining = COOLDOWN_MS - (now - lastUsed);

        if (remaining > 0) {
            return message.reply(
                `⏳ Slow down! Wait **${(remaining / 1000).toFixed(1)}s** before searching again.`
            );
        }

        cooldowns.set(message.author.id, now);

        // ── Cache lookup ────────────────────────────────────────────────────
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
                // Fire typing indicator and API call simultaneously
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

                if (!results || results.length === 0) {
                    return message.reply("❌ No images found for that query.");
                }

                images = results
                    .slice(0, RESULTS_PER_QUERY)
                    .filter(img => img.original && img.original.startsWith("http"))
                    .map(img => ({
                        url: img.original,
                        title: img.title || query,
                        source: img.link || img.original
                    }));

                searchTimeMs = Date.now() - fetchStart;

                // Save to cache
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

        // ── Send the first result ───────────────────────────────────────────
        const session = {
            images,
            index: 0,
            query,
            owner: message.author.id,
            messageRef: null
        };

        const embed = buildEmbed(session);
        const row = buildDynamicRow(session);

        const timingNote = cacheHit
            ? "*(cached)*"
            : `*(fetched in ${searchTimeMs}ms)*`;

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

    const session = sessions.get(interaction.message.id);

    if (!session) {
        return interaction.reply({
            content: "❌ This session has expired. Run the search again.",
            ephemeral: true
        });
    }

    // ── Download ────────────────────────────────────────────────────────────
    if (interaction.customId === "download") {
        return interaction.reply({
            content: `💾 **Direct URL:**\n${session.images[session.index].url}`,
            ephemeral: true
        });
    }

    // ── Delete (owner only) ─────────────────────────────────────────────────
    if (interaction.customId === "delete") {
        if (interaction.user.id !== session.owner) {
            return interaction.reply({
                content: "❌ Only the person who ran this search can delete it.",
                ephemeral: true
            });
        }
        clearTimeout(session.timer);
        sessions.delete(interaction.message.id);
        await interaction.deferUpdate();
        return interaction.message.delete();
    }

    // ── Navigation (owner only) ─────────────────────────────────────────────
    if (interaction.customId === "next" || interaction.customId === "prev") {

        if (interaction.user.id !== session.owner) {
            return interaction.reply({
                content: "❌ Only the person who ran this search can navigate results.",
                ephemeral: true
            });
        }

        if (interaction.customId === "next") {
            session.index = (session.index + 1) % session.images.length;
        } else {
            session.index = (session.index - 1 + session.images.length) % session.images.length;
        }

        // Write back explicitly
        sessions.set(interaction.message.id, session);

        return interaction.update({
            embeds: [buildEmbed(session)],
            components: [buildDynamicRow(session)]
        });
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);