# Telegram Bot Integration

Kesher can bridge chat messages between intercom party‑lines and Telegram groups/channels. Messages sent in a mapped Telegram chat appear in the intercom party‑line, and messages sent in the intercom party‑line are forwarded to Telegram.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Step 1: Create a Telegram Bot](#step-1-create-a-telegram-bot)
- [Step 2: Get the Chat ID](#step-2-get-the-chat-id)
- [Step 3: Configure Kesher](#step-3-configure-kesher)
- [Step 4: Create Chat–Party‑Line Mappings](#step-4-create-chat-party‑line-mappings)
- [How It Works](#how-it-works)
- [Polling vs. Webhook Mode](#polling-vs-webhook-mode)
- [Environment Variables Reference](#environment-variables-reference)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- A running Kesher backend instance with internet access (outbound HTTPS to `api.telegram.org`)
- A Telegram account to create the bot

> **Note:** The server does NOT need a public IP or domain name. The default **polling mode** works from behind NAT/firewalls because it only makes outbound connections.

---

## Step 1: Create a Telegram Bot

1. Open Telegram and search for **@BotFather** (or go to [https://t.me/BotFather](https://t.me/BotFather)).
2. Send `/newbot`.
3. Follow the prompts:
   - Enter a **display name** for your bot (e.g. `Production Intercom`).
   - Enter a **username** for your bot (must end in `bot`, e.g. `my_intercom_bot`).
4. BotFather will reply with your **bot token**, which looks like:
   ```
   123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
   ```
5. **Copy this token** — you will need it in Step 3.

### Optional: Customize your bot

You can send these commands to @BotFather to customize the bot:

| Command | Purpose |
|---|---|
| `/setdescription` | Set a short description shown when users open the bot |
| `/setabouttext` | Set the "About" text on the bot's profile |
| `/setuserpic` | Upload a profile picture for the bot |
| `/setcommands` | Set command suggestions (not required for Kesher) |

### Privacy settings

By default, bots in **group chats** only receive messages that are commands (`/command`) or directly mention the bot. To let the bot see **all messages** in a group:

1. Send `/mybots` to @BotFather.
2. Select your bot.
3. Go to **Bot Settings** → **Group Privacy**.
4. Set it to **Disabled** (this means privacy mode is off, so the bot sees all messages).

> **Important:** If you skip this step, the bot will only see messages that start with `/` or mention the bot directly. Normal chat messages will not be forwarded to the intercom.

---

## Step 2: Get the Chat ID

You need the numeric **Chat ID** of every Telegram group or channel you want to bridge.

### Method A: Use the bot itself

1. Add your bot to the Telegram group.
2. Send any message in the group.
3. Open this URL in a browser (replace `<TOKEN>` with your bot token):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Look for `"chat":{"id":-100XXXXXXXXXX}` in the JSON response. The number (including the minus sign) is your Chat ID.

### Method B: Use @RawDataBot

1. Add **@RawDataBot** to the group temporarily.
2. It will reply with a JSON message containing `"chat":{"id":-100XXXXXXXXXX}`.
3. Copy the Chat ID.
4. Remove @RawDataBot from the group.

### Chat ID format

| Chat Type | ID Format | Example |
|---|---|---|
| Private chat | Positive number | `123456789` |
| Group | Negative number | `-987654321` |
| Supergroup / Channel | Starts with `-100` | `-1001234567890` |

---

## Step 3: Configure Kesher

Set the environment variable `TELEGRAM_BOT_TOKEN` with the token from Step 1 before starting the backend.

### Using environment variables directly

```bash
export TELEGRAM_BOT_TOKEN="123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
make run-backend
```

### Using Docker Compose

Add the variable to your `docker-compose.yml`:

```yaml
services:
  backend:
    environment:
      - TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
```

### Using a `.env` file

```env
TELEGRAM_BOT_TOKEN=123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw
```

### Verify configuration

After starting the backend, open the Kesher web UI and go to **Admin Panel** → **Telegram Bot Integration** → **Show**. You should see:

- **Bot status:** ✓ Configured
- **Mode:** Polling (server fetches updates from Telegram)

If you see "✗ Not configured", the token was not picked up. Check that the environment variable is set correctly.

---

## Step 4: Create Chat–Party‑Line Mappings

Mappings connect a Telegram chat to an intercom party‑line. You can create multiple mappings (e.g., one Telegram group per party‑line).

1. In the Kesher web UI, go to **Admin Panel** → **Telegram Bot Integration** → **Show**.
2. Click **Add mapping**.
3. Fill in:
   - **Telegram chat ID**: The numeric chat ID from Step 2 (e.g. `-1001234567890`)
   - **Label**: A human-readable name for this mapping (e.g. `FOH Team`)
   - **Party‑Line**: Select the intercom party‑line to bridge to
4. Click **Add mapping** to save.

You can create, edit, and delete mappings at any time. Changes take effect immediately.

### Example mappings

| Label | Chat ID | Party‑Line |
|---|---|---|
| FOH Team | `-1001111111111` | foh |
| Stage Crew | `-1002222222222` | stage |
| All Hands | `-1003333333333` | broadcast |

---

## How It Works

### Sender authorization and target scope

- Only Telegram users on the Telegram allowlist are allowed to send messages into Kesher.
- Once allowlisted and logged in, those Telegram users can target all Kesher users, roles, and party-lines.
- The allowlist controls who may send from Telegram, not which Kesher targets are visible.

### Telegram → Intercom

1. A user sends a message in the mapped Telegram group.
2. The Kesher server receives the message (via polling or webhook).
3. The message is injected into the mapped intercom party‑line as a chat event.
4. All intercom users listening to that party‑line see the message, prefixed with the Telegram sender's name (e.g. `[@alice] Hello everyone`).

### Intercom → Telegram

1. An intercom user sends a chat message to a party‑line.
2. If that party‑line has one or more Telegram mappings, the message is forwarded to each mapped Telegram chat.
3. The message appears in Telegram as `[username] message text`.

---

## Polling vs. Webhook Mode

Kesher supports two modes for receiving Telegram messages:

### Polling mode (default) — recommended for LAN/local servers

The server periodically calls Telegram's `getUpdates` API to fetch new messages. This only requires **outbound** internet access.

```bash
# Polling is the default, no extra config needed:
export TELEGRAM_BOT_TOKEN="your-token"
export TELEGRAM_MODE="polling"   # optional, this is already the default
```

**Advantages:**
- Works behind NAT, firewalls, and on LAN-only servers
- No public IP or domain required
- No TLS certificate needed for Telegram
- Simplest setup

**How it works internally:**
- The server opens a long-polling connection to `api.telegram.org/getUpdates` with a 30-second timeout
- When Telegram has new messages, it responds immediately
- If no messages arrive within 30 seconds, the connection is refreshed
- On startup, any previously set webhook is automatically removed

### Webhook mode — for publicly accessible servers

Telegram sends HTTP POST requests to your server whenever a message arrives. Requires the server to be reachable from the internet on HTTPS.

```bash
export TELEGRAM_BOT_TOKEN="your-token"
export TELEGRAM_MODE="webhook"
export TELEGRAM_WEBHOOK_SECRET="a-random-secret-string"  # optional but recommended
```

After starting the server, you need to register the webhook URL with Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-domain.com/api/telegram/webhook",
    "secret_token": "a-random-secret-string"
  }'
```

Or use the webhook URL shown in the Kesher admin panel.

**Advantages:**
- Instant message delivery (no polling delay)
- Slightly lower resource usage

**Requirements:**
- Server must be reachable from the internet on HTTPS
- Valid TLS certificate (Telegram requires HTTPS)
- Public domain name or IP

---

## Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Bot token from @BotFather. If empty, Telegram integration is disabled. |
| `TELEGRAM_MODE` | `polling` | `polling` or `webhook`. Use `polling` for LAN servers. |
| `TELEGRAM_WEBHOOK_SECRET` | *(empty)* | Shared secret for webhook authentication. Only used in webhook mode. Should be a random string. Telegram sends this in the `X-Telegram-Bot-Api-Secret-Token` header. |

---

## Troubleshooting

### Bot is configured but no messages arrive from Telegram

1. **Check Group Privacy** — Make sure you disabled Group Privacy in @BotFather (see Step 1). Without this, the bot only sees `/commands` in groups.
2. **Check the bot is in the group** — The bot must be a member of the Telegram group.
3. **Check the Chat ID** — Verify the Chat ID is correct by calling `https://api.telegram.org/bot<TOKEN>/getUpdates` after sending a message.
4. **Check server logs** — Look for `telegram message from unmapped chat` log entries, which indicate messages are arriving but not mapped to a party‑line.
5. **Check internet access** — The server needs outbound HTTPS access to `api.telegram.org` on port 443.

### Telegram user cannot send messages to Kesher users/roles/party-lines

1. **Check allowlist entry** — The Telegram sender must be present in the Telegram allowlist.
2. **Check `/login` status** — The user must run `/login` in a private chat with the bot first.
3. **Check message format for direct routing** — Use inline routing so the message is emitted as `/ksh_user:*`, `/ksh_role:*`, or `/ksh_room:*`.
4. **Check target existence** — If a user/role/party-line was removed in Kesher, delivery can fail.

### Messages appear in the intercom but not in Telegram

1. **Check the bot token** — Verify the token is valid by calling `https://api.telegram.org/bot<TOKEN>/getMe`.
2. **Check the bot has permission to post** — In channels, the bot must be added as an **administrator** with "Post Messages" permission.
3. **Check server logs** — Look for `failed to forward chat to telegram` warnings.

### "✗ Not configured" in admin panel

The `TELEGRAM_BOT_TOKEN` environment variable is not set or is empty. Make sure it's set before the backend process starts. If using Docker, ensure it's passed through in the compose file.

### Bot token was leaked / compromised

1. Go to @BotFather and send `/revoke` to generate a new token.
2. Update the `TELEGRAM_BOT_TOKEN` environment variable with the new token.
3. Restart the Kesher backend.

> **Security note:** Never hardcode the bot token in source code or commit it to version control. Always use environment variables.

### Webhook mode: 401 Unauthorized

The `TELEGRAM_WEBHOOK_SECRET` on your server doesn't match the `secret_token` you used when registering the webhook. Re-register the webhook with the correct secret.

### Webhook mode: Telegram can't reach the server

- The server must be accessible from the internet on HTTPS (port 443).
- Self-signed certificates are NOT accepted by Telegram (unless you upload the certificate when setting the webhook — see [Telegram docs](https://core.telegram.org/bots/api#setwebhook)).
- Consider switching to **polling mode** if you cannot expose the server publicly.
