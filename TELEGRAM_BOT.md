# Telegram Bot Integration

The Telegram bot is **built into the intercom backend**. No separate process, no webhook, no internet exposure needed — the server long-polls Telegram directly.

When `TELEGRAM_BOT_TOKEN` is set the backend automatically bridges two-way chat between configured Telegram chats and intercom rooms.

---

## How it works

```
Telegram                          Intercom backend
────────                          ────────────────
Group/user message
      │
      │  long-poll (getUpdates)
      ▼
 TelegramBridge  ──BroadcastChatToRoom──▶  Hub  ──▶  WebSocket clients
      ▲
      │  SubscribeChat fanout
      └──────────────────────────────────  Hub  ◀──  WebSocket clients
                                                        send chat event
```

- **Telegram → Intercom:** The bridge polls `getUpdates` in a loop (no inbound port required). When a message arrives from a mapped Telegram chat it is injected into the intercom hub and delivered to all room listeners.
- **Intercom → Telegram:** When any user sends a chat message to a mapped room the bridge receives it via an internal subscription channel and calls `sendMessage` on the Telegram API.

---

## Step 1 — Create the bot

1. Open Telegram and start a chat with **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts to choose a name and username (must end in `bot`).
3. Copy the **API token** BotFather gives you (e.g. `1234567890:ABCdef...`). Keep it secret.
4. Disable bot privacy mode so the bot can read all group messages:
   - `/mybots` → select your bot → **Bot Settings → Group Privacy → Turn off**

---

## Step 2 — Find the Telegram chat IDs

You need the numeric ID of every Telegram chat you want to bridge.

| Chat type | How to get the ID |
|-----------|-------------------|
| **Private chat** | Start a conversation with your bot; the `chat.id` in the first update is the user ID |
| **Group** | Add `@userinfobot` to the group and send `/start@userinfobot`; it replies with the group's ID (a negative integer like `-100123456789`) |
| **Via raw API** | `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` — look for `"chat":{"id":...}` in the response after sending a test message |

---

## Step 3 — Find your intercom room IDs

```bash
curl http://localhost:8080/api/public-bootstrap | jq '.rooms[] | {id, name}'
```

Room IDs are the UUID-like strings (e.g. `aaaaaaaa-0000-0000-0000-000000000001`).

---

## Step 4 — Configure the backend

Set these environment variables before starting the server:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot API token from BotFather |
| `TELEGRAM_ROOM_MAP` | ✅ | — | Comma-separated `roomId:chatId` pairs (see format below) |
| `TELEGRAM_BOT_USERNAME` | — | `telegram-bot` | Name the bot appears under in the intercom chat |

### `TELEGRAM_ROOM_MAP` format

```
<roomId>:<telegramChatId>,<roomId>:<telegramChatId>,...
```

Example:

```
TELEGRAM_ROOM_MAP=aaaaaaaa-0000-0000-0000-000000000001:-100123456789,aaaaaaaa-0000-0000-0000-000000000002:987654321
```

A negative chat ID (group) is handled correctly — the split always uses the **last** colon in each pair.

---

## Step 5 — Run the server

```sh
# Development
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGhIJK \
TELEGRAM_ROOM_MAP=<roomId>:<chatId> \
make run-backend

# Production (existing env file)
echo "TELEGRAM_BOT_TOKEN=1234567890:ABCdefGhIJK" >> deploy/compose/.env
echo "TELEGRAM_ROOM_MAP=<roomId>:<chatId>"       >> deploy/compose/.env
make docker-up
```

On startup you will see a log line:

```json
{"level":"INFO","msg":"telegram bridge started","rooms":1}
```

If the token is wrong or Telegram is unreachable the bridge logs a warning and retries every 5 seconds — it never crashes the server.

---

## Message format

| Direction | What appears in chat |
|-----------|----------------------|
| Telegram → intercom | `[TG:alice] Hello from Telegram` |
| Intercom → Telegram | `[operator1] Hello from intercom` |

The sender name shown in the intercom for Telegram messages is controlled by `TELEGRAM_BOT_USERNAME` (default `telegram-bot`). You can change it to anything descriptive, e.g. `telegram`.

---

## Security notes

| Topic | Details |
|-------|---------|
| **Token storage** | Store `TELEGRAM_BOT_TOKEN` in an env file or secrets manager. Never commit it to source control. |
| **No inbound port** | The bridge uses outbound long-polling only — no webhook, no exposed port, no internet inbound access required. |
| **Chat allowlist** | Only Telegram chats listed in `TELEGRAM_ROOM_MAP` are bridged. Messages from unknown chats are silently ignored. |
| **Loop prevention** | Messages injected by the bot (identified by `TELEGRAM_BOT_USERNAME`) are not re-forwarded back to Telegram. |
| **Rate limiting** | Telegram limits bots to 30 messages/second globally and 1 message/second per chat. The bridge drops messages that cannot be sent (non-blocking channel) and logs a warning; it does not crash or queue unbounded messages. |
