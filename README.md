# 🎬 FileStream Bot

A high-performance Telegram bot for file streaming and downloading, built with **Python**, **Pyrogram**, **aiohttp**, and **MongoDB**.

---

## ✨ Features

- **⚡ Range Request Support** — video seeking and resumable downloads
- **📦 Efficient Streaming** — 1 MB chunk size, aligned to Telegram's `upload.GetFile` limit
- **🔗 MongoDB Connection Pooling** — fast async queries via Motor
- **💾 File ID Storage** — direct Telegram file access without re-downloading
- **🔐 Secure Links** — HMAC-SHA256 signed file hashes
- **📢 Log Channel** — new user registrations and file uploads logged automatically
- **⚙️ Settings Panel** — full bot configuration via inline keyboard (`/bot_settings`)
- **🌐 Themed Web Pages** — `/stats`, `/bandwidth`, `/health` served as styled HTML pages (JSON available via `Accept: application/json`)
- **🎬 Stream Button** — auto-shown for video and audio files in all file views
- **🐳 Docker Support** — ready-to-use `Dockerfile`

---

## 🏗️ Project Structure

```
filestream-bot/
├── main.py              # Entry point — boots bot + web server
├── app.py               # aiohttp web app (routes + HTML/JSON responses)
├── bot.py               # Pyrogram client
├── config.py            # Configuration + logging setup
├── FLiX/
│   ├── __init__.py
│   ├── admin.py         # /bot_settings, /adminstats, /revoke, /revokeall, /logs
│   ├── gen.py           # File upload handler, /files, inline query, callbacks
│   └── start.py         # /start, /help, /about
├── database/
│   └── mongodb.py       # Motor async MongoDB client
├── helper/
│   ├── __init__.py
│   ├── bandwidth.py     # Bandwidth check helper
│   ├── crypto.py        # HMAC hash utility
│   ├── stream.py        # ByteStreamer + StreamingService
│   └── utils.py         # format_size, small_caps, check_owner, check_fsub, …
└── templates/           # Jinja2 HTML templates
    ├── home.html
    ├── stream.html
    ├── not_found.html
    ├── bandwidth_exceeded.html
    ├── stats.html
    ├── bandwidth_info.html
    └── health.html
```

---

## 🚀 Installation

### Prerequisites

- Python 3.11+
- MongoDB 6.0+
- Telegram Bot Token — [@BotFather](https://t.me/BotFather)
- Telegram API ID & Hash — [my.telegram.org](https://my.telegram.org)

### Method 1 — Docker (Recommended)

```bash
git clone <your-repo-url>
cd filestream-bot
cp .env.example .env
# Edit .env with your values
docker build -t filestream-bot .
docker run -d --env-file .env filestream-bot
```

### Method 2 — Manual

```bash
git clone <your-repo-url>
cd filestream-bot
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your values
python main.py
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `API_ID` | ✅ | Telegram API ID from my.telegram.org |
| `API_HASH` | ✅ | Telegram API Hash from my.telegram.org |
| `FLOG_CHAT_ID` | ✅ | Channel ID where files are stored (dump channel) |
| `OWNER_ID` | ✅ | Your Telegram user ID (comma-separated for multiple) |
| `DB_URI` | ✅ | MongoDB connection string |
| `DATABASE_NAME` | — | MongoDB database name (default: `filestream_bot`) |
| `URL` | — | Public base URL for stream/download links |
| `PORT` | — | Web server port (default: `8080`) |
| `LOGS_CHAT_ID` | — | Channel ID for logging new users (0 to disable) |
| `SECRET_KEY` | — | HMAC secret for link signing |
| `Start_IMG` | — | URL of image shown with `/start` |
| `Files_IMG` | — | URL of image shown with `/files` |
| `FSUB_ID` | — | Initial force-subscription channel ID |
| `FSUB_INV_LINK` | — | Initial invite link for force-subscription |
| `PUBLIC_BOT` | — | `True`/`False` — allow everyone (default: `False`) |
| `MAX_BANDWIDTH` | — | Bandwidth limit in bytes (default: 100 GB) |
| `MAX_FILE_SIZE` | — | Max accepted file size in bytes (default: 4 GB) |

> **Note:** `PUBLIC_BOT`, `MAX_BANDWIDTH`, bandwidth mode, force-sub settings, and sudo users are all managed live via `/bot_settings` and stored in MongoDB. The env variables above serve as **initial defaults** only.

---

## 🤖 Bot Commands

### User Commands

| Command | Description |
|---|---|
| `/start` | Welcome message with feature overview |
| `/help` | Usage guide |
| `/about` | Bot information |
| `/files` | View your uploaded files with stream/download/revoke options |

### Owner Commands

| Command | Description |
|---|---|
| `/bot_settings` | Full settings panel (bandwidth, sudo users, bot mode, force-sub) |
| `/adminstats` | Detailed bot statistics (uptime, users, files, bandwidth) |
| `/revoke <hash>` | Revoke a specific file and invalidate its links |
| `/revokeall` | Delete all files (shows confirm/cancel prompt) |
| `/revokeall <user_id>` | Delete all files belonging to a specific user |
| `/logs` | Receive the current `bot.log` file as a document |
| `/files <user_id>` | View another user's files (owner view with revoke option) |

> All settings are managed via the `/bot_settings` inline panel — no separate text commands needed.

---

## 📋 Log Channel Events

When `LOGS_CHAT_ID` is set, the bot automatically posts:

- `#NewUser` — whenever a new user starts the bot

---

## 🌐 Web Endpoints

| Path | Browser | `Accept: application/json` |
|---|---|---|
| `GET /` | Home page | — |
| `GET /stream/<hash>` | Inline media player | Raw stream |
| `GET /dl/<hash>` | Force-download | Force-download |
| `GET /stats` | Styled stats page | JSON stats |
| `GET /bandwidth` | Styled bandwidth page | JSON bandwidth details |
| `GET /health` | Styled health page | JSON health check |

---

## 📦 Dependencies

```
pyrogram
tgcrypto
motor
aiohttp
aiohttp-jinja2
jinja2
python-dotenv
```

---

## 👨‍💻 Developer

Built by [@FLiX_LY](https://t.me/FLiX_LY)
