# Telegram Bot Integration Guide

This guide contains everything you need to build a Telegram Bot that bridges Telegram users with the Live Production Intercom system.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step 1 – Create Your Telegram Bot](#step-1--create-your-telegram-bot)
4. [Step 2 – Understand the Intercom API](#step-2--understand-the-intercom-api)
5. [Step 3 – Design the Integration Architecture](#step-3--design-the-integration-architecture)
6. [Step 4 – Implement the Bot](#step-4--implement-the-bot)
7. [Step 5 – Deploy the Bot](#step-5--deploy-the-bot)
8. [Step 6 – Configure Telegram Mapping in the Intercom](#step-6--configure-telegram-mapping-in-the-intercom)
9. [Security Considerations](#security-considerations)
10. [Troubleshooting](#troubleshooting)
11. [Reference](#reference)

---

## Overview

The integration works as a **bridge service** that sits between Telegram and the intercom backend. It does two things:

- **Telegram → Intercom:** Receives updates from Telegram (via webhook or long-polling) and forwards them as chat messages into the intercom's WebSocket bus.
- **Intercom → Telegram:** Subscribes to the intercom's event stream and forwards relevant chat messages to configured Telegram chats or users.

```
Telegram User
     │
     ▼  HTTPS webhook / long-poll
┌─────────────────┐
│   Bot Bridge    │  (your new service)
│  (Node/Python/  │
│   Go / etc.)    │
└────────┬────────┘
         │  REST + WebSocket
         ▼
┌─────────────────┐
│  Intercom       │
│  Backend        │
└─────────────────┘
```

---

## Prerequisites

| Item | Details |
|------|---------|
| Telegram account | Required to register the bot via BotFather |
| Intercom backend | Running and reachable; see the main [README.md](README.md) |
| Runtime | Node.js 18+ **or** Python 3.10+ **or** Go 1.21+ |
| Public URL (webhook mode) | HTTPS endpoint reachable by Telegram's servers; a free ngrok tunnel is fine for development |
| `BOT_TOKEN` | Provided by BotFather after bot creation |

---

## Step 1 – Create Your Telegram Bot

1. Open Telegram and start a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts:
   - Choose a display name (e.g. `Production Intercom`).
   - Choose a username that ends in `bot` (e.g. `prod_intercom_bot`).
3. BotFather replies with your **HTTP API token** — keep this secret:
   ```
   1234567890:ABCdefGhIJKlmNoPQRstuVWXyz
   ```
4. Optionally configure the bot further:
   ```
   /setdescription  – describe what the bot does
   /setprivacy      – set to "Disabled" if the bot must read all group messages
   /setcommands     – register slash commands (see below)
   ```

### Recommended slash commands

Register these with BotFather via `/setcommands`:

```
start   - Show welcome message and link your Telegram account
status  - Show your current intercom presence
help    - Show available commands
```

---

## Step 2 – Understand the Intercom API

### REST endpoints

All REST endpoints are under the base URL of your running backend (default `http://localhost:8080`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/healthz` | None | Health check |
| `GET` | `/api/public-bootstrap` | None | Returns all roles, rooms, and broadcast groups |
| `POST` | `/api/login` | None | Log in and receive a bearer token |
| `POST` | `/api/logout` | Bearer | Invalidate the current token |
| `GET` | `/api/bootstrap` | Bearer | Full state: self, roles, rooms, broadcast groups, users |
| `GET` | `/api/companion/discovery?username=<username>` | None | Returns rooms and capabilities for a given user |

**Login request body:**
```json
{
  "username": "telegram-bot",
  "roleId":   "<role-id-from-public-bootstrap>"
}
```

**Login response:**
```json
{
  "token": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "user": {
    "id":       "...",
    "username": "telegram-bot",
    "roleId":   "..."
  }
}
```

Pass the token in every subsequent request:
```
Authorization: Bearer <token>
```

### WebSocket — main bus (`/ws`)

Connect with:
```
ws://localhost:8080/ws?token=<token>
```

All frames are JSON with the shape `{ "type": "<event>", "data": { ... } }`.

**Outbound (server → client) event types:**

| Type | Description |
|------|-------------|
| `chat` | A chat message was delivered to this client |
| `signal` | A signal event (e.g. `call`) was delivered |
| `voice_state` | Another user's voice state changed |
| `presence` | Full presence list update |
| `webrtc_offer` | WebRTC SDP offer (ignore if not doing audio) |
| `companion_command` | A companion command sent to this user |

**Inbound (client → server) event types:**

| Type | Required `data` fields | Description |
|------|------------------------|-------------|
| `chat` | `scope`, `targetId`, `body` | Send a chat message |
| `signal` | `scope`, `targetId`, `body`, `signal` | Send a signal |
| `set_active_room` | `roomId` | Change the active room |
| `set_room_matrix` | `listenRoomIds`, `talkRoomIds` | Update room subscription matrix |
| `voice_state` | `scope`, `targetId`, `body` (`ptt_start`/`ptt_stop`/`always_on`/`listen_only`) | Change voice state |
| `webrtc_ready` | — | Signals that the client is ready for WebRTC (skip if audio-free) |
| `webrtc_answer` | `sdp` | Send WebRTC SDP answer |
| `webrtc_ice_candidate` | `candidate`, `sdpMid`, `sdpMLineIndex` | ICE candidate exchange |

**Chat message example (bot sending to a room):**
```json
{
  "type": "chat",
  "data": {
    "scope":    "room",
    "targetId": "<room-id>",
    "body":     "Hello from Telegram: @alice says hi!"
  }
}
```

**Chat message received (bot reading from socket):**
```json
{
  "type": "chat",
  "data": {
    "scope":     "room",
    "targetId":  "<room-id>",
    "body":      "This is a message from the intercom",
    "fromUser":  { "id": "...", "username": "operator1", "roleId": "..." },
    "timestamp": 1700000000000
  }
}
```

### Companion WebSocket (`/api/companion/ws`)

This is a lighter-weight control channel that does **not** require a full login session. Use it to send commands on behalf of a named user:

```
ws://localhost:8080/api/companion/ws?username=<username>
```

The server pushes `companion_state` frames every 250 ms and on every presence change:

```json
{
  "type": "companion_state",
  "data": {
    "username": "operator1",
    "bound":    true,
    "presence": { "userId": "...", "activeRoom": "...", "voiceMode": "ptt", ... },
    "signalActive": false
  }
}
```

Send a command:
```json
{
  "type": "command",
  "data": {
    "commandId": "cmd-001",
    "command":   "send_chat",
    "scope":     "room",
    "targetId":  "<room-id>",
    "body":      "Message from Telegram bot"
  }
}
```

Available companion commands:

| `command` | Additional fields | Description |
|-----------|-------------------|-------------|
| `send_chat` | `scope`, `targetId`, `body` | Send a chat message as the target user |
| `send_signal` | `scope`, `targetId`, `signal`, `body` | Send a signal |
| `set_voice_mode` | `mode` (`always_on` / `ptt` / `listen_only`) | Change voice mode |
| `set_active_room` | `activeRoomId` | Change the active room |
| `set_room_matrix` | `activeRoomId`, `listenRoomIds`, `talkRoomIds` | Update room matrix |
| `set_broadcast_state` | `targetId`, `state` (`active`/`inactive`) | Toggle a broadcast group |
| `ptt_start` / `ptt_stop` | `scope`, `targetId` | Push-to-talk control |

---

## Step 3 – Design the Integration Architecture

### Recommended approach

The bot service needs to:

1. **Authenticate** with the intercom backend using a dedicated bot user and role.
2. **Maintain a WebSocket connection** to `/ws` to receive and send intercom chat messages.
3. **Run a Telegram receiver** (webhook or long-poll) to receive Telegram messages.
4. **Map Telegram users** to intercom rooms (stored in a local config file or DB).
5. **Forward messages** in both directions.

### User/room mapping

Keep a simple JSON or environment-variable config:

```json
{
  "rooms": [
    {
      "roomId":   "<room-id>",
      "chatId":   "-100123456789",
      "label":    "Stage Left"
    }
  ],
  "users": [
    {
      "telegramUserId": 987654321,
      "intercomUsername": "alice"
    }
  ]
}
```

`chatId` can be:
- A **group chat ID** (negative number starting with `-100`) — all members see the message.
- A **private chat ID** (positive number) — only that user sees the message.

Obtain a chat ID by adding `@userinfobot` to a group and sending `/start`, or by inspecting the `chat.id` field in incoming Telegram update payloads.

---

## Step 4 – Implement the Bot

Below are fully-working reference implementations. Choose one language.

### Option A — Node.js (with `node-telegram-bot-api` and `ws`)

#### Install dependencies

```bash
npm init -y
npm install node-telegram-bot-api ws axios dotenv
```

#### `.env`

```dotenv
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGhIJKlmNoPQRstuVWXyz
INTERCOM_BASE_URL=http://localhost:8080
INTERCOM_USERNAME=telegram-bot
INTERCOM_ROLE_ID=<role-id>
WEBHOOK_URL=https://your-public-domain.example/telegram-webhook
WEBHOOK_SECRET=changeme
```

#### `bot.js`

```js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const WebSocket   = require('ws');
const axios       = require('axios');

const MAPPING = require('./mapping.json');  // see Step 3 above

const BASE  = process.env.INTERCOM_BASE_URL;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

let intercomToken = null;
let ws            = null;

// ── 1. Login to intercom ──────────────────────────────────────────────────────
async function login() {
  const { data } = await axios.post(`${BASE}/api/login`, {
    username: process.env.INTERCOM_USERNAME,
    roleId:   process.env.INTERCOM_ROLE_ID,
  });
  intercomToken = data.token;
  console.log('Intercom login OK, token:', intercomToken);
}

// ── 2. Connect WebSocket to intercom ─────────────────────────────────────────
function connectIntercom() {
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws?token=' + intercomToken;
  ws = new WebSocket(wsUrl);

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'chat') return;

    const { scope, targetId, body, fromUser } = msg.data;
    if (fromUser.username === process.env.INTERCOM_USERNAME) return; // skip own messages

    const entry = MAPPING.rooms.find(r => r.roomId === targetId);
    if (!entry) return;

    const text = `[${fromUser.username}] ${body}`;
    bot.sendMessage(entry.chatId, text);
  });

  ws.on('close', () => {
    console.warn('Intercom WS closed — reconnecting in 5s');
    setTimeout(connectIntercom, 5000);
  });

  ws.on('error', err => console.error('Intercom WS error:', err.message));
}

// ── 3. Send a chat message to intercom ───────────────────────────────────────
function sendToIntercom(roomId, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'chat',
    data: { scope: 'room', targetId: roomId, body: text },
  }));
}

// ── 4. Set up Telegram bot ───────────────────────────────────────────────────
// Use webhook in production; switch to { polling: true } for local dev.
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${process.env.WEBHOOK_URL}`, {
  secret_token: process.env.WEBHOOK_SECRET,
});

bot.on('message', msg => {
  if (!msg.text) return;
  const chatId  = msg.chat.id.toString();
  const sender  = msg.from.username || msg.from.first_name;
  const entry   = MAPPING.rooms.find(r => r.chatId === chatId);
  if (!entry) return;

  sendToIntercom(entry.roomId, `[TG:${sender}] ${msg.text}`);
});

// /start command
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, 'Production Intercom bot active. Messages here are bridged to the intercom.');
});

// ── 5. Start ─────────────────────────────────────────────────────────────────
(async () => {
  await login();
  connectIntercom();
  console.log('Bot bridge running.');
})();
```

For **local development** replace `bot.setWebHook(...)` with:
```js
const bot = new TelegramBot(TOKEN, { polling: true });
```

---

### Option B — Python (with `python-telegram-bot` and `websockets`)

#### Install dependencies

```bash
pip install python-telegram-bot==21.* aiohttp websockets python-dotenv
```

#### `.env`

```dotenv
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGhIJKlmNoPQRstuVWXyz
INTERCOM_BASE_URL=http://localhost:8080
INTERCOM_USERNAME=telegram-bot
INTERCOM_ROLE_ID=<role-id>
```

#### `bot.py`

```python
import asyncio, json, os, logging
import aiohttp, websockets
from telegram import Update
from telegram.ext import Application, MessageHandler, CommandHandler, filters
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE     = os.environ["INTERCOM_BASE_URL"]
TG_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]

with open("mapping.json") as f:
    MAPPING = json.load(f)

room_by_telegram: dict[str, str]  = {r["chatId"]: r["roomId"]  for r in MAPPING["rooms"]}
room_by_intercom: dict[str, str]  = {r["roomId"]: r["chatId"]  for r in MAPPING["rooms"]}

intercom_token: str | None = None
tg_app: Application | None = None

# ── Login ─────────────────────────────────────────────────────────────────────
async def login():
    global intercom_token
    async with aiohttp.ClientSession() as s:
        resp = await s.post(f"{BASE}/api/login", json={
            "username": os.environ["INTERCOM_USERNAME"],
            "roleId":   os.environ["INTERCOM_ROLE_ID"],
        })
        data = await resp.json()
    intercom_token = data["token"]
    logger.info("Intercom login OK")

# ── Intercom WebSocket listener ───────────────────────────────────────────────
async def intercom_listener():
    global intercom_ws
    ws_url = BASE.replace("http", "ws", 1) + f"/ws?token={intercom_token}"
    while True:
        try:
            async with websockets.connect(ws_url) as ws:
                intercom_ws = ws
                logger.info("Connected to intercom WS")
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") != "chat":
                        continue
                    d = msg["data"]
                    if d["fromUser"]["username"] == os.environ["INTERCOM_USERNAME"]:
                        continue
                    chat_id = room_by_intercom.get(d["targetId"])
                    if not chat_id:
                        continue
                    text = f"[{d['fromUser']['username']}] {d['body']}"
                    await tg_app.bot.send_message(chat_id=int(chat_id), text=text)
        except Exception as e:
            logger.warning(f"Intercom WS error: {e} — reconnecting in 5s")
        finally:
            intercom_ws = None
            await asyncio.sleep(5)

intercom_ws: websockets.WebSocketClientProtocol | None = None

async def send_to_intercom(room_id: str, text: str):
    if intercom_ws and intercom_ws.open:
        try:
            await intercom_ws.send(json.dumps({
                "type": "chat",
                "data": {"scope": "room", "targetId": room_id, "body": text},
            }))
        except Exception as e:
            logger.warning(f"Failed to send message to intercom: {e}")
    else:
        logger.warning("Intercom WS not connected — message dropped")

# ── Telegram handlers ─────────────────────────────────────────────────────────
async def on_message(update: Update, context):
    msg = update.effective_message
    if not msg or not msg.text:
        return
    chat_id = str(update.effective_chat.id)
    room_id = room_by_telegram.get(chat_id)
    if not room_id:
        return
    sender = update.effective_user.username or update.effective_user.first_name
    await send_to_intercom(room_id, f"[TG:{sender}] {msg.text}")

async def on_start(update: Update, context):
    await update.message.reply_text("Production Intercom bot active.")

# ── Main ──────────────────────────────────────────────────────────────────────
async def main():
    global tg_app
    await login()

    tg_app = Application.builder().token(TG_TOKEN).build()
    tg_app.add_handler(CommandHandler("start", on_start))
    tg_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_message))

    async with tg_app:
        await tg_app.start()
        await asyncio.gather(
            intercom_listener(),
            tg_app.updater.start_polling(),
        )

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Step 5 – Deploy the Bot

### Environment variables summary

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from BotFather |
| `INTERCOM_BASE_URL` | ✅ | Full URL of your intercom backend, e.g. `https://intercom.example.org` |
| `INTERCOM_USERNAME` | ✅ | Bot's username in the intercom (e.g. `telegram-bot`) |
| `INTERCOM_ROLE_ID` | ✅ | UUID of the role the bot user should log in as |
| `WEBHOOK_URL` | Webhook mode | Full HTTPS URL Telegram will POST updates to |
| `WEBHOOK_SECRET` | Webhook mode | Header secret to validate incoming Telegram requests |
| `PORT` | Optional | HTTP port for the webhook receiver (default: `3000`) |

### Webhook vs. long-polling

| | Webhook | Long-polling |
|---|---------|-------------|
| **Latency** | Near-instant | ~1–2 s |
| **Requirements** | Public HTTPS URL | None |
| **Best for** | Production | Local development |

#### Setting a webhook (production)

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d url="https://your-domain.example/telegram-webhook" \
  -d secret_token="changeme"
```

Verify:
```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

#### Development tunnel with ngrok

```bash
ngrok http 3000
# copy the https URL, then:
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d url="https://xxxx.ngrok-free.app/telegram-webhook"
```

### Docker Compose example

```yaml
services:
  telegram-bot:
    build: ./telegram-bot
    restart: unless-stopped
    environment:
      TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}"
      INTERCOM_BASE_URL: "http://backend:8080"
      INTERCOM_USERNAME: "telegram-bot"
      INTERCOM_ROLE_ID: "${INTERCOM_ROLE_ID}"
    volumes:
      - ./mapping.json:/app/mapping.json:ro
    depends_on:
      - backend
```

---

## Step 6 – Configure Telegram Mapping in the Intercom

### 1. Find the role ID for the bot

```bash
curl http://localhost:8080/api/public-bootstrap | jq '.roles'
```

If no suitable role exists, create one via the admin panel or:

```bash
curl -X POST http://localhost:8080/api/admin/roles \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"id":"bot","name":"Telegram Bot","defaultVoiceMode":"ptt"}'
```

### 2. Find room IDs

```bash
curl http://localhost:8080/api/public-bootstrap | jq '.rooms[] | {id, name}'
```

### 3. Find Telegram chat IDs

- **Private chat:** `/start` your bot from a personal account and inspect `update.message.chat.id` in the webhook payload.
- **Group chat:** Add `@userinfobot` to the group, type `/start@userinfobot`. The reply contains the group's chat ID (a negative integer).
- **Bot must be a group member and privacy mode must be disabled** (set via BotFather `/setprivacy → Disable`) for the bot to receive all group messages.

### 4. Build `mapping.json`

```json
{
  "rooms": [
    { "roomId": "aaaaaaaa-0000-0000-0000-000000000001", "chatId": "-100987654321", "label": "Stage Left" },
    { "roomId": "aaaaaaaa-0000-0000-0000-000000000002", "chatId": "-100111222333", "label": "FOH" }
  ],
  "users": [
    { "telegramUserId": 12345678, "intercomUsername": "alice" }
  ]
}
```

---

## Security Considerations

| Topic | Recommendation |
|-------|----------------|
| **Bot token** | Store in environment variables or a secrets manager. Never commit it to source control. |
| **Webhook secret** | Always set `secret_token` when registering the webhook. Validate the `X-Telegram-Bot-Api-Secret-Token` header on every incoming request. |
| **Intercom token TTL** | The default session TTL is 720 minutes (`SESSION_TTL_MINUTES`). Re-authenticate before expiry or handle `401` responses with automatic re-login. |
| **Message sanitisation** | Strip or escape markdown and HTML in both directions to prevent injection in Telegram messages. |
| **Rate limiting** | Telegram limits bots to 30 messages/second globally and 1 message/second per chat. Add a send queue with back-off. |
| **Group membership validation** | Check that the Telegram `chat.id` is in your allowlist (`mapping.json`) before bridging messages. Reject unknown chat IDs. |
| **TLS** | The intercom backend must be reachable over HTTPS when deployed; see the main [README.md](README.md) for TLS options. |
| **Logging** | Log every bridged message with Telegram user ID and intercom room ID for audit purposes. Do not log message bodies at INFO level in production. |

---

## Troubleshooting

### Bot does not receive group messages

- Open a chat with BotFather → `/mybots` → select your bot → **Bot Settings → Group Privacy → Turn off**.
- The bot must be added as a **member** of the group, not just invited.

### `401 Unauthorized` from intercom

- The session token has expired. Implement a re-login loop: catch `401` on any REST call or WS close, call `/api/login` again, and reconnect.

### WebSocket disconnects frequently

- The intercom server sends a **ping** every 30 seconds and expects a **pong** back within 5 seconds. Most WS libraries handle this automatically. Verify your library's `autoPong` option is enabled.

### Messages appear twice

- Check that the bot filters out its own messages using the `fromUser.username` field.

### Telegram webhook returns 403

- Verify the `X-Telegram-Bot-Api-Secret-Token` header value matches `WEBHOOK_SECRET`.
- Ensure the public HTTPS URL is accessible from the internet (not behind a firewall).

### Intercom room not found for a chat ID

- Print the raw `update.message.chat.id` and compare with the values in `mapping.json`. Group IDs are negative; user IDs are positive.

---

## Reference

### Telegram Bot API

- Official docs: <https://core.telegram.org/bots/api>
- Bot API base URL: `https://api.telegram.org/bot<token>/<method>`
- Webhook registration: `POST /setWebhook`
- Send message: `POST /sendMessage`

### Intercom backend API summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/healthz` | GET | — | Health check |
| `/api/public-bootstrap` | GET | — | Roles, rooms, broadcast groups |
| `/api/login` | POST | — | Obtain bearer token |
| `/api/logout` | POST | Bearer | Revoke token |
| `/api/bootstrap` | GET | Bearer | Full state including users |
| `/api/admin/roles` | GET / POST | Bearer | Manage roles |
| `/api/admin/roles/{id}` | GET / PUT / DELETE | Bearer | Manage single role |
| `/api/admin/rooms` | GET / POST | Bearer | Manage rooms |
| `/api/admin/rooms/{id}` | GET / PUT / DELETE | Bearer | Manage single room |
| `/api/admin/broadcast-groups` | GET / POST | Bearer | Manage broadcast groups |
| `/api/admin/broadcast-groups/{id}` | GET / PUT / DELETE | Bearer | Manage single broadcast group |
| `/api/companion/discovery` | GET | — | Per-user room/capability snapshot |
| `/ws?token=<token>` | WS | Token in query | Main event bus |
| `/api/companion/ws?username=<user>` | WS | — | Companion control channel |

### WS chat message shape

```ts
// Inbound (bot → intercom)
{
  type: "chat",
  data: {
    scope:    "room" | "direct" | "broadcast",
    targetId: string,   // room ID, user ID, or broadcast group ID
    body:     string,   // message text
  }
}

// Outbound (intercom → bot)
{
  type: "chat",
  data: {
    scope:     "room" | "direct" | "broadcast",
    targetId:  string,
    body:      string,
    fromUser:  { id: string, username: string, roleId: string },
    timestamp: number,  // Unix ms
  }
}
```
