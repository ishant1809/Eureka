# 🚀 Eureka

> A powerful Discord utility, moderation, and entertainment bot built with Discord.js.

Eureka combines useful server tools, message tracking, image search, smart notification systems, and high-stakes interactive games into a single bot. Whether you're looking for moderation utilities or simply want to create unforgettable server moments, Eureka has you covered.

---

## ✨ Features

### 🏓 Utility Commands

| Command | Description |
|----------|------------|
| `.ping` | Displays bot latency and API response time |
| `.help` | Shows the complete command list |
| `.usage` | Displays SerpAPI usage statistics and quota information |

---

### 🖼️ Image Search

Search and browse images directly inside Discord.

**Command**
```text
.img <query>
```

**Features**
- Google Image Search powered by SerpAPI
- Interactive navigation buttons
- Source links
- Image downloading
- Session management with automatic expiration
- Cached results for faster repeated searches

---

### 🕵️ Message Tracking (Snipe System)

Recover recently deleted or edited messages.

| Command | Description |
|----------|------------|
| `.snipe` | View the most recently deleted message |
| `.msnipe` | View up to 25 recently deleted messages |
| `.esnipe` | View the most recently edited message |

**Includes**
- Author information
- Timestamps
- Attachments
- Before/after edit comparison
- Jump links

---

### 🔔 SetMention Notifications

Get notified when specific words or phrases are mentioned.

**Commands**
```text
.sm <text>
.sm clear
```

**How it works**
- Set a trigger phrase
- Receive a DM whenever someone mentions it
- Includes the previous 10 messages for context
- Persistent storage across restarts

Example:

```text
.sm javascript internship
```

Whenever someone says "javascript internship" in the server, you'll receive a DM notification with context.

---

## 🔫 Russian Roulette (1v1)

Challenge another member to a game of Russian Roulette.

**Command**
```text
.rr @user
```

### Rules

- One bullet
- Six chambers
- Random firing order
- Players alternate turns
- Whoever gets the bullet loses

### Features

- Challenge / Accept system
- Automatic timeout handling
- AFK detection
- Interactive buttons
- Real-time game updates

⚠️ Losers may be kicked from the server if the bot has permission.

---

## 🔫 Multiplayer Russian Roulette

A larger version of the classic game.

**Command**
```text
.rrm
```

### Features

- 2–6 players
- Joinable lobby
- Randomized turn order
- Round-based elimination
- AFK detection
- Automatic progression
- Last survivor wins

Every round:
- A fresh revolver is loaded
- One player is eliminated
- The game continues until only one player remains

---

## ⚙️ Technical Features

### Smart Caching

- Persistent JSON cache
- Automatic cleanup
- 24-hour cache lifetime
- Reduced API usage

### Session Management

- Interactive image browsing sessions
- Automatic expiration after inactivity
- Memory-safe cleanup

### Cooldown Protection

- Per-user cooldowns
- Prevents command abuse
- Reduces spam

### Persistent Data Storage

Stores:
- Cached searches
- SetMention triggers
- Bot configuration

---

## 📦 Installation

### Clone the Repository

```bash
git clone https://github.com/yourusername/eureka.git
cd eureka
```

### Install Dependencies

```bash
npm install
```

### Create Environment Variables

Create a `.env` file in the root directory:

```env
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
SERVER_ID=YOUR_SERVER_ID
SERP_API_KEY=YOUR_SERPAPI_KEY
```

### Start the Bot

```bash
node index.js
```

---

## 🔑 Required Environment Variables

| Variable | Description |
|-----------|-------------|
| DISCORD_TOKEN | Discord bot token |
| SERVER_ID | Discord server ID |
| SERP_API_KEY | SerpAPI API key |

---

## 🔒 Required Discord Permissions

The bot should have:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Attach Files
- Use External Emojis
- Manage Messages (optional)
- Kick Members (required for Russian Roulette)

---

## 📂 Project Highlights

### Utility
- Ping monitoring
- API usage tracking
- Interactive help system

### Moderation
- Deleted message recovery
- Edited message tracking
- Server activity visibility

### Community Engagement
- Smart mention alerts
- Image search
- Interactive games

### Entertainment
- Russian Roulette
- Multiplayer Russian Roulette

---


## 🛠 Built With

- Node.js
- Discord.js v14
- Axios
- SerpAPI
- JavaScript

---

## 📜 License

MIT License

---

## 👨‍💻 Author

**Ishant Bhandari**

Built with Discord.js, curiosity, and a little bit of chaos.

If you like Eureka, consider giving the repository a ⭐.