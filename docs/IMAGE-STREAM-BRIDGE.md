# Stream Deck key images

Kesher draws every Stream Deck key image itself and sends it to Companion
as a finished PNG. Companion only shows it. This keeps the look under
Kesher's control (Companion's own button styles are too limited) and keeps
the Companion module small: no drawing code, no native packages.

```
Kesher server (Go)                         Companion module
──────────────────                         ────────────────
key state changes ──► ButtonImageRenderer ──► /api/image-stream ──► ImageBridge
(talk, listen, call,    draws a 72 px PNG      WebSocket, one per     keeps the latest
 page change, …)        or takes it from        deck (?deck=…)         image per page/key
                        its cache                                      │
                                                                       ▼
                                                    "Display Dynamic Web-UI Button Image"
                                                    feedback returns it to Companion
```

## Server (`backend/internal/app/image_stream.go`)

- `ButtonImageRenderer` draws a key from a `ButtonState` (label, subtitle,
  action type, color, state, listening, selected for talk). The fonts are
  parsed once; each renderer keeps its font faces and the images it drew,
  so a state it has seen (on another deck, after paging back, the two
  phases of a blinking call) costs no drawing. A new key takes about
  2 ms, a repeated one well under a microsecond.
- States: `IDLE`, `TALK` (red, your mic goes out), `LISTEN`, `BROADCAST`,
  and `CALL` (yellow) for the "on" phase of an incoming call.
- Blinking is done by the server: while a call waits, the Companion bridge
  (`/api/companion/ws`) ticks every 300 ms and the affected keys alternate
  between `CALL` and their normal state (`companionCallBlinkState` in
  `server.go`). `ButtonState.Calling` says a call is waiting.
- `ImageStreamCoordinator` sends an image only to the decks it belongs to
  and only when it differs from what that deck already has. Changes are
  pushed right away; a connected deck is refreshed every 15 s as a safety
  net, a deck that is not known yet is looked up every 2 s.
- The layout editor in the app shows the same images
  (`POST /api/user/stream-deck/preview`), drawn by a shared renderer per
  size.

### Message

```json
{
  "type": "update_button_image",
  "bank": 0,
  "buttonIndex": 7,
  "imageBuffer": "<base64 PNG>",
  "state": "CALL",
  "label": "Reply",
  "actionType": "reply_to_caller"
}
```

`bank` is the Kesher page, `buttonIndex` the key (0–14). The other fields
are for logs and debugging.

## Companion module (`companion-module-kesher`)

- `ImageBridge` keeps one WebSocket to `/api/image-stream` (with the deck
  and the shared secret in the query) and stores the base64 image per page
  and key. It reconnects on its own with 1 s, 2 s, 4 s … up to 30 s, for as
  long as the connection is configured.
- The feedback "Display Dynamic Web-UI Button Image" returns the stored
  image for the current page; a key without an image is cleared rather than
  showing another page's image.

## Debugging

- `/api/debug/button-image?state=CALL&label=Reply` renders one key as PNG,
  `/api/debug/button-image-preview` shows a few states side by side.
- Module variables `image_connected`, `image_ws_state`,
  `image_reconnect_attempts`, `image_last_message_at`, `image_last_error`
  and `image_stored_images` show the image stream from Companion's side.
