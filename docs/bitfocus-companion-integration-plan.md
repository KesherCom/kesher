# Bitfocus Companion integration - Remaining work only

## Problem statement

Keep only the unimplemented tasks required to complete the Companion integration hardening and polish.

## Current implemented baseline

The following are already in place and are not part of this remaining plan:

- Companion module exists and connects over bridge WS.
- Discovery endpoint is implemented.
- Browser receives and applies companion commands.
- Core actions/feedbacks/variables/presets exist.

## Remaining backend work

### 1) Enforce authorization before forwarding companion commands

- Validate companion commands server-side against existing role/policy rules before forwarding to browser.
- Return structured command errors when unauthorized/invalid instead of relying on browser-side rejection.
- Touchpoints: `backend/internal/app/server.go`, `backend/internal/app/store.go`.

### 2) Add optional bridge hardening controls

- Optional shared secret/token check for companion WS + discovery endpoints.
- Optional username allowlist for companion-controlled users.
- Config-driven enable/disable so trusted-LAN default behavior can remain simple.
- Touchpoints: `backend/internal/app/config.go`, `backend/internal/app/server.go`.

### 3) Add multi-session warning state for username binding

- Keep deterministic latest-session selection, but expose warning metadata when multiple browser sessions match a username.
- Include this warning in companion state payload so UI feedback/variables can surface ambiguity.
- Touchpoints: `backend/internal/app/hub.go`, `backend/internal/app/models.go`, `backend/internal/app/server.go`.

### 4) Add companion bridge tests

- Unit tests for:
  - username-to-session binding edge cases
  - command authorization outcomes
  - offline target handling
  - disconnect/reconnect behavior for bridge subscribers
- Touchpoints: `backend/internal/app/*_test.go`.

## Remaining companion module work

### 5) Add missing feedback capabilities

- Add feedback for “active party‑line equals X”.
- Add feedback for “target PTT active” (party‑line/direct/broadcast target).
- Touchpoints: `KesherCom/companion-module-kesher/src/feedbacks.ts`.

### 6) Expose reconnect/backoff tuning in module config

- Add advanced config fields for reconnect behavior and wire into existing reconnect logic.
- Touchpoints: `KesherCom/companion-module-kesher/src/config.ts`, `KesherCom/companion-module-kesher/src/main.ts`.

## Validation strategy

- `make test` for backend/frontend baseline.
- Companion module build/package check in external companion repo (`npm run build`, `npm run package`).
- Manual verification with:
  - one operator + one companion instance
  - multiple browser sessions for one username (warning visible)
  - unauthorized command attempts (proper rejection/error feedback)
