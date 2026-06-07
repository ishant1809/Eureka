require("dotenv").config();

const axios = require("axios");

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ─────────────────────────────────────────────
// Image search session store
// ─────────────────────────────────────────────
const sessions = new Map();

// ─────────────────────────────────────────────
// Snipe stores — keyed by channelId
// ─────────────────────────────────────────────
const deletedMessages = new Map(); // .snipe
const MSNIPE_LIMIT = 25;
const deletedMessageStack = new Map(); // .msnipe
const editedMessages = new Map(); // .esnipe

// ─────────────────────────────────────────────
// Russian Roulette store — keyed by channelId
// ─────────────────────────────────────────────
// Game state shape:
// {
//   players:     [userId, userId],
//   names:       { userId: displayName },
//   turn:        userId,
//   chamber:     [bool, bool, bool, bool, bool, bool],  // true = bullet
//   shotsOrder:  [0,1,2,3,4,5] shuffled — random pull order
//   shotsFired:  number,
//   pending:     bool,
//   challenger:  userId,
//   challenged:  userId,
//   gameMessage: Message | null  // the live game message with the Shoot button
// }
const rrGames = new Map();

const RR_TOTAL_SHOTS = 6;

// Shuffle an array in place (Fisher-Yates)
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Build a fresh chamber and a random shot order
function buildGame() {
    // Randomly place 1 bullet in 6 chambers
    const chamber = Array(RR_TOTAL_SHOTS).fill(false);
    chamber[Math.floor(Math.random() * RR_TOTAL_SHOTS)] = true;

    // Random order in which the 6 chamber slots are pulled
    const shotsOrder = shuffle([0, 1, 2, 3, 4, 5]);

    return { chamber, shotsOrder };
}

function rrStatusBar(shotsFired) {
    const bars = [];
    for (let i = 0; i < RR_TOTAL_SHOTS; i++) {
        bars.push(i < shotsFired ? "🔘" : "⚪");
    }
    return bars.join(" ");
}

// Build the Shoot button row (enabled/disabled)
function shootRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("rr_shoot")
            .setLabel("🔫 Pull the Trigger")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

// ─────────────────────────────────────────────
// Snipe / general helpers
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Ready
// ─────────────────────────────────────────────
client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Gateway Ping: ${client.ws.ping}ms`);
});

// ─────────────────────────────────────────────
// messageDelete  →  snipe stores
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// messageUpdate  →  esnipe store
// ─────────────────────────────────────────────
client.on("messageUpdate", (oldMessage, newMessage) => {
    if (oldMessage.partial || newMessage.partial) return;
    if (newMessage.author?.bot) return;
    if (newMessage.guild?.id !== process.env.SERVER_ID) return;
    if (oldMessage.content === newMessage.content) return; // embed-only update

    editedMessages.set(newMessage.channel.id, {
        author: newMessage.author,
        before: oldMessage.content || "",
        after: newMessage.content || "",
        editedAt: new Date(),
        url: newMessage.url
    });
});

// ─────────────────────────────────────────────
// messageCreate  →  commands
// ─────────────────────────────────────────────
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.guild?.id !== process.env.SERVER_ID) return;

    const cid = message.channel.id;
    const prefix = message.content.trim().toLowerCase();

    // ── .help ──────────────────────────────────────────────────────────────
    if (prefix === ".help") {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("📖 Command List")
            .setDescription("Here's everything this bot can do:")
            .addFields(
                { name: "🏓 `.ping`", value: "Check if the bot is alive and view latency.", inline: false },
                { name: "🖼️ `.img <query>`", value: "Search Google Images and browse with buttons. ⬅ ➡ navigate, 💾 download link, 🗑 remove.", inline: false },
                { name: "🗑️ `.snipe`", value: "Show the **last deleted message** in this channel.", inline: false },
                { name: "📜 `.msnipe`", value: "Show the last **up to 25 deleted messages** in this channel.", inline: false },
                { name: "✏️ `.esnipe`", value: "Show the **last edited message** in this channel with before/after diff.", inline: false },
                { name: "🔫 `.rr @user`", value: "Challenge someone to Russian Roulette — 6 chambers, 1 bullet, random pull order. Loser gets kicked. Copy your invite link first!", inline: false },
                { name: "✅ Accept / ❌ Decline", value: "Use the buttons on the challenge message to accept or back down.", inline: false },
                { name: "💥 Pull the Trigger", value: "Click the **🔫 Pull the Trigger** button when it's your turn.", inline: false }
            )
            .setFooter({ text: "All snipe commands are channel-specific." })
            .setTimestamp();

        return message.reply({ embeds: [embed] });
    }

    // ── .ping ──────────────────────────────────────────────────────────────
    if (prefix === ".ping") {
        const start = Date.now();
        const sent = await message.reply("🏓 Pinging...");
        const latency = Date.now() - start;
        return sent.edit(`🏓 Pong!\n📡 Latency: ${latency}ms\n🤖 API Ping: ${client.ws.ping}ms`);
    }

    // ── .snipe ─────────────────────────────────────────────────────────────
    if (prefix === ".snipe") {
        const data = deletedMessages.get(cid);
        if (!data) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("🔍 No recently deleted messages found in this channel.")]
            });
        }
        return message.reply({ embeds: [buildDeleteEmbed(data, cid)] });
    }

    // ── .msnipe ────────────────────────────────────────────────────────────
    if (prefix === ".msnipe") {
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
    if (prefix === ".esnipe") {
        const data = editedMessages.get(cid);
        if (!data) {
            return message.reply({
                embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription("🔍 No recently edited messages found in this channel.")]
            });
        }
        return message.reply({ embeds: [buildEditEmbed(data, cid)] });
    }

    // ── .rr @user ──────────────────────────────────────────────────────────
    if (message.content.toLowerCase().startsWith(".rr ")) {
        const target = message.mentions.members?.first();

        if (!target) {
            return message.reply("Usage: `.rr @user` — mention someone to challenge them.");
        }
        if (target.id === message.author.id) {
            return message.reply("❌ You can't challenge yourself... although that's kinda brave.");
        }
        if (target.user.bot) {
            return message.reply("❌ Bots don't die. Challenge a real person.");
        }
        if (rrGames.has(cid)) {
            return message.reply("❌ A game is already running in this channel. Wait for it to finish.");
        }

        // Randomly decide who goes first
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

        // Challenge embed with Accept / Decline buttons
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
            new ButtonBuilder()
                .setCustomId("rr_accept")
                .setLabel("✅ Accept")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("rr_decline")
                .setLabel("❌ Decline")
                .setStyle(ButtonStyle.Secondary)
        );

        return message.channel.send({ embeds: [embed], components: [row] });
    }

    // ── .img <query> ───────────────────────────────────────────────────────
    if (message.content.startsWith(".img ")) {
        const query = message.content.slice(5).trim();
        if (!query) return message.reply("Usage: `.img <search term>`");

        try {
            await message.reply(`🔍 Searching Google Images for **"${query}"**...`);

            const response = await axios.get("https://serpapi.com/search.json", {
                params: { engine: "google_images", q: query, api_key: process.env.SERP_API_KEY }
            });

            const results = response.data.images_results;
            if (!results || results.length === 0) return message.channel.send("❌ No images found.");

            const images = results.slice(0, 20).map(img => ({
                url: img.original,
                title: img.title || query
            }));

            const embed = new EmbedBuilder()
                .setTitle(images[0].title)
                .setDescription(`Image 1/${images.length}`)
                .setImage(images[0].url)
                .setFooter({ text: `Search: ${query}` });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("prev").setLabel("⬅ Previous").setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId("next").setLabel("➡ Next").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("download").setLabel("💾 Download").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("delete").setLabel("🗑 Delete").setStyle(ButtonStyle.Danger)
            );

            const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });
            sessions.set(sentMessage.id, { images, index: 0, query, owner: message.author.id });

        } catch (error) {
            console.error(error.response?.data || error);
            return message.channel.send("❌ Image search failed. Please try again.");
        }
    }
});

// ─────────────────────────────────────────────
// interactionCreate  →  buttons
// ─────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    const cid = interaction.channel.id;

    // ══════════════════════════════════════════
    // Russian Roulette buttons
    // ══════════════════════════════════════════

    // ── Accept ─────────────────────────────────
    if (interaction.customId === "rr_accept") {
        const game = rrGames.get(cid);
        if (!game || !game.pending) {
            return interaction.reply({ content: "❌ No pending challenge here.", ephemeral: true });
        }
        if (interaction.user.id !== game.challenged) {
            return interaction.reply({ content: "❌ This challenge isn't for you.", ephemeral: true });
        }

        game.pending = false;
        const firstName = game.names[game.turn];

        // Disable the accept/decline buttons on the challenge message
        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("rr_accept").setLabel("✅ Accept").setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId("rr_decline").setLabel("❌ Decline").setStyle(ButtonStyle.Secondary).setDisabled(true)
        );
        await interaction.update({ components: [disabledRow] });

        // Post the live game message with the Shoot button
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
            .setFooter({ text: "3 shots each • 1 bullet • random pull order • good luck" })
            .setTimestamp();

        const gameMsg = await interaction.channel.send({
            embeds: [startEmbed],
            components: [shootRow(false)]
        });

        game.gameMessage = gameMsg;

        // DM the server invite link to both players
        try {
            const invite = await interaction.channel.createInvite({
                maxAge: 3600, // expires in 1 hour
                maxUses: 2,    // challenger + challenged
                reason: "Russian Roulette safety net invite"
            });

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

            // Warn in channel for any player whose DMs are closed
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
            await interaction.channel.send(
                "⚠️ Couldn't generate an invite link — make sure I have the `Create Instant Invite` permission."
            );
        }

        return;
    }

    // ── Decline ────────────────────────────────
    if (interaction.customId === "rr_decline") {
        const game = rrGames.get(cid);
        if (!game || !game.pending) {
            return interaction.reply({ content: "❌ No pending challenge here.", ephemeral: true });
        }
        if (interaction.user.id !== game.challenged) {
            return interaction.reply({ content: "❌ This challenge isn't for you.", ephemeral: true });
        }

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

    // ── Shoot ──────────────────────────────────
    if (interaction.customId === "rr_shoot") {
        const game = rrGames.get(cid);

        if (!game || game.pending) {
            return interaction.reply({ content: "❌ No active game here.", ephemeral: true });
        }

        if (interaction.user.id !== game.turn) {
            return interaction.reply({
                content: `⏳ It's not your turn! Wait for <@${game.turn}> to pull the trigger.`,
                ephemeral: true
            });
        }

        // Disable the button immediately so nobody double-clicks
        await interaction.update({ components: [shootRow(true)] });

        // Pull from the random shot order
        const chamberSlot = game.shotsOrder[game.shotsFired];
        const bullet = game.chamber[chamberSlot];
        game.shotsFired++;

        const currentIndex = game.players.indexOf(game.turn);
        const nextIndex = currentIndex === 0 ? 1 : 0;
        const nextPlayer = game.players[nextIndex];

        // ── BANG — someone dies ─────────────────
        if (bullet) {
            rrGames.delete(cid);

            const loser = interaction.member;
            const winner = interaction.guild.members.cache.get(game.players[nextIndex]);

            // Death embed
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

            // Separate kick message with laughing emojis
            await interaction.channel.send(
                `😂🤣😂 **${loser.displayName}** just got kicked for losing Russian Roulette lmaooo 💀🔫😂🤣😂`
            );

            // Kick
            try {
                await loser.kick("Lost a game of Russian Roulette 🔫");
            } catch {
                await interaction.channel.send(
                    `⚠️ Couldn't kick **${loser.displayName}** — missing \`Kick Members\` permission or they outrank me.`
                );
            }

            return;
        }

        // ── Survived ────────────────────────────
        const isGameOver = game.shotsFired >= RR_TOTAL_SHOTS;

        if (isGameOver) {
            // Safety net — all 6 shots fired, nobody hit the bullet
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

        // Switch turn and post updated game state
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

        // Post a new message with a fresh enabled Shoot button
        const newMsg = await interaction.channel.send({
            embeds: [survivedEmbed],
            components: [shootRow(false)]
        });

        game.gameMessage = newMsg;
        return;
    }

    // ══════════════════════════════════════════
    // Image search buttons
    // ══════════════════════════════════════════
    const session = sessions.get(interaction.message.id);

    if (!session) {
        return interaction.reply({ content: "❌ Session expired.", ephemeral: true });
    }

    if (interaction.customId === "download") {
        return interaction.reply({ content: session.images[session.index].url, ephemeral: true });
    }

    if (interaction.customId === "delete") {
        if (interaction.user.id !== session.owner) {
            return interaction.reply({ content: "❌ Only the creator of this search can delete it.", ephemeral: true });
        }
        sessions.delete(interaction.message.id);
        await interaction.deferUpdate();
        return interaction.message.delete();
    }

    if (interaction.customId === "next") {
        session.index = (session.index + 1) % session.images.length;
    }
    if (interaction.customId === "prev") {
        session.index = (session.index - 1 + session.images.length) % session.images.length;
    }

    const current = session.images[session.index];
    const embed = new EmbedBuilder()
        .setTitle(current.title)
        .setDescription(`Image ${session.index + 1}/${session.images.length}`)
        .setImage(current.url)
        .setFooter({ text: `Search: ${session.query}` });

    await interaction.update({ embeds: [embed] });
});

// ─────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);