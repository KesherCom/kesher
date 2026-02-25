# live-production-intercom Companion module

Custom Bitfocus Companion module for controlling `live-production-intercom` browser sessions.

## What it does

- Connects to backend bridge WebSocket: `/api/companion/ws?username=<username>`
- Loads discovery data from: `/api/companion/discovery?username=<username>`
- Exposes actions for:
  - voice mode (`always_on` / `ptt`)
  - listen/talk room matrix selection
  - PTT to active room
  - PTT to explicit target (`room` / `direct` / `broadcast`)
  - reply to latest direct caller (PTT)
  - scoped signal sending
- Exposes feedbacks for:
  - bridge connected/bound
  - mic live
  - voice mode
  - active room
  - listen/talk selected rooms
  - last command failed

## Develop/build

```sh
npm install
npm run build
```

If you use Yarn 4:

```sh
yarn
yarn build
```

## Package for Companion local install

```sh
npm run package
```

This uses `companion-module-build` and produces a package artifact in this module directory.

## Install in Bitfocus Companion (local module)

1. Build/package this module.
2. In Companion, add a local custom module (or import local module package artifact).
3. Configure:
   - backend host/port
   - TLS on/off
   - target username (must match an active intercom browser session username)
4. Add actions/presets to buttons.

## Notes

- The module controls an existing browser session; it does not capture microphone audio itself.
- Commands are acknowledged with command IDs and surfaced via `last_command_ok` / `last_command_error` variables and failure feedback.
