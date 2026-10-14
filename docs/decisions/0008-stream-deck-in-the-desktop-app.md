# 0008: The desktop app drives its Stream Deck directly

Date: 2026-10-14 · Status: accepted

## Context

Stream Decks went through Bitfocus Companion because the first plan was a
browser-only client: a browser cannot reliably own a USB device, Companion
can. Operators now use the desktop app for its audio path. Going through
Companion then means an extra program to install and configure per PC, a
pairing code per deck (decision 0006), and an extra hop for every key
press: deck → Companion → server → app.

## Decision

1. **The desktop app talks to a Stream Deck plugged into its PC over USB
   HID** (`crates/kesher-deck`, `hidapi`; Tauri side
   `desktop/src-tauri/src/stream_deck.rs`). First model: the 15-key
   Stream Deck MK.2 (and the protocol-identical original v2). Other models
   are recognised and named, and come one by one.
2. **The server stays the brain.** The app uses the same endpoints as
   Companion with `?deck=<serial>`: key presses as `press_button` on
   `/api/companion/ws`, key images from `/api/image-stream`
   (`hooks/useNativeStreamDeck.ts`). Layouts, pages, states, blinking and the
   key renderer stay in one place; the app only turns the server's PNG into
   the JPEG the model wants (size, 180° rotation) and writes it.
3. **No pairing code.** Being plugged into the PC is the proof: the app binds
   the deck to its place by serial (`POST /api/user/stream-decks/attach`),
   moving it from another place if needed. On the Companion endpoints the
   app authenticates with its login token (`?token=`), which only opens a
   deck bound to that login's place; the Companion secret is not needed.
4. **Companion stays** for decks without a Kesher app next to them and for
   setups that mix intercom keys with other gear (ATEM, OBS, light). It is
   kept working, not extended.

## Consequences

- Plug in, log in, the keys work; the layout editor edits that deck.
- One program at a time can use a deck: the Elgato software or Companion
  must not hold it. The settings page says so.
- A key press still makes one round trip to the server (LAN, a few ms). If
  that ever matters for push-to-talk, the app can act on talk keys locally
  first; the server path stays the reference.
- The same crate can later give the Raspberry Pi station a Stream Deck (it
  then needs a udev rule in the `.deb`).

## Revisit when

- A model needs a different protocol (Stream Deck +, Neo: dials and touch
  strip) — extend `protocol.rs` per model.
- Key presses through the server are measurably too slow for talk keys.
