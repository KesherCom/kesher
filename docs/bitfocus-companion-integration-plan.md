# Problem statement
Design and implement a custom Bitfocus Companion module (not Stream Deck SDK) that gives each operator a personal Stream Deck control surface for the existing intercom, including global PTT/always-on, room/direct/broadcast talk, signal actions, listen-source selection, and real-time button feedback.
The first implementation should control an operator’s active browser session (browser remains the media/WebRTC endpoint), with robust reconnect and disabled controls during disconnect.
## Current state (relevant code)
The backend already provides login/session bootstrap and a WebSocket command channel for intercom control:
- REST login/bootstrap: `backend/internal/app/server.go:205`, `backend/internal/app/server.go:249`
- WebSocket endpoint and inbound message handling (`set_room_matrix`, `voice_state`, `signal`, etc.): `backend/internal/app/server.go:534`, `backend/internal/app/server.go:641`
- Role-policy enforcement on inbound routed events: `backend/internal/app/server.go:746`
- Presence model/state broadcast: `backend/internal/app/models.go:78`, `backend/internal/app/hub.go:247`
The frontend browser app is currently the only control client and owns microphone/WebRTC:
- WebSocket lifecycle/reconnect and media init: `web/src/App.tsx:515`
- Outbound control helpers (`sendScopedVoiceState`, `set_room_matrix`, signal): `web/src/App.tsx:904`, `web/src/App.tsx:587`
- Local UI state for PTT/direct/broadcast/listen selections and feedback: `web/src/App.tsx:35`, `web/src/App.tsx:1049`
## Proposed architecture
### 1) Browser-controlled integration model (MVP)
Adopt a control-bridge architecture where Companion sends control commands to backend APIs, and backend forwards them to the user’s active browser session.
- Browser stays responsible for mic capture + WebRTC transport.
- Companion becomes a remote control surface and state subscriber.
- This avoids implementing Node-side audio/WebRTC capture in the module and matches desired operator workflow.
A future browser-independent mode can be considered separately (non-goal for this iteration).
### 2) Backend: Companion control plane
Add a companion-specific control layer in backend app package.
- New logical session concept: control-targetable browser sessions, keyed by user and session token.
- Browser registration: when authenticated browser WS connects, it registers metadata needed for external control routing.
- Companion connection endpoint (WebSocket preferred): dedicated channel for Companion module instances to subscribe to state and send control commands.
- Discovery endpoints for module config choices:
  - list controllable users (online/offline, role)
  - rooms (including role-send/receive capability for selected user)
  - broadcast groups
- Command endpoints/messages (validated with existing role checks before apply):
  - set voice mode (`always_on`, `ptt_stop`)
  - start/stop PTT by scope (`room`, `direct`, `broadcast`)
  - send signal by scope/target
  - set active room and listen/talk matrix
- State projection messages for Companion:
  - connection status
  - operator mic live
  - selected active room
  - selected listen rooms / talk rooms
  - PTT active states per scope target
  - recent command result/error for feedback coloring
### 3) Frontend: control-bridge client
Extend browser app with control-command intake and explicit state publish.
- Add WS outbound state snapshots when room matrix, voice mode, or PTT state changes.
- Add WS inbound command handling from backend companion bridge.
- Reuse existing in-app control methods (`setAlwaysOn`, `startPtt`, `stopPtt`, `startDirectPtt`, `startBroadcastPtt`, room matrix updates) so Companion-triggered actions follow identical behavior to UI clicks.
- Ensure browser sends authoritative state updates after every command acceptance.
### 4) Companion custom module (TypeScript)
Create a standalone custom module based on `companion-module-template-ts` and `@companion-module/base`.
- Instance configuration:
  - backend URL
  - operator username (primary binding key)
  - reconnect/backoff tuning (advanced)
  - optional shared secret/token field if enabled server-side
- Core module internals:
  - persistent WS client to companion control endpoint
  - local state cache for feedbacks/variables
  - exponential reconnect and status transitions
  - disable actions while disconnected/unbound
- Actions exposed:
  - global: set always-on on/off, PTT press/release
  - room: select active room, toggle room listen, room PTT press/release
  - direct: select user target, direct PTT press/release
  - broadcast: select group, broadcast PTT press/release
  - signaling: send signal (room/direct/broadcast target)
- Feedbacks exposed:
  - module connected/bound
  - mic live
  - voice mode (always-on/PTT)
  - active room equals X
  - room listen contains X
  - room talk contains X
  - target PTT active
  - last command failed (momentary/error latch)
- Presets/variables:
  - default operator pages (room bank, direct bank, broadcast bank, utility row)
  - variables for selected room, mode, live mic, connection state, and current target names.
### 5) Binding model for multiple operators/devices
Support one Companion instance per operator identity, while Companion itself handles multiple attached Stream Deck devices.
- Binding rule for MVP: module instance binds by configured username to the most recent active browser session for that username.
- If multiple browser sessions exist for same username, backend returns deterministic winner + warning state (and optional session selector later).
- No admin/config mutation actions are exposed in module.
### 6) Error handling and reconnect behavior
- Companion side: when bridge disconnects, set module status to warning/error, disable live-control actions, auto-reconnect with bounded backoff.
- Backend side: stale browser session bindings expire quickly; commands to offline users return structured “target unavailable”.
- Frontend side: if control bridge commands arrive during local reconnect, queue minimally or reject with retryable error.
### 7) Security model for trusted LAN
MVP can operate with LAN trust + username binding, but implement optional hardening without redesign:
- optional control secret in module config validated server-side
- optional allowlist of usernames controllable via companion bridge
- structured command audit logs (disabled by default, can be enabled later)
## Rollout approach
Start with a thin vertical slice and expand:
1. End-to-end MVP path for one operator: connect module, toggle always-on/PTT, observe mic-live feedback.
2. Add scoped targeting (room/direct/broadcast) and listen-source controls.
3. Add discovery-driven presets/variables and richer feedback states.
4. Validate concurrent operators and reconnect resilience.
5. Package module artifact for Companion import and document install/update workflow.
## Validation strategy
Backend
- Unit tests in `backend/internal/app/` for companion bridge routing, username-to-session binding, command authorization, and disconnect behavior.
- Integration-like tests for command-to-presence state propagation.
Frontend
- Build validation plus focused tests around command intake and state publication logic.
Companion module
- Action execution tests/mocked socket tests for reconnect, disable-on-disconnect, and feedback evaluation.
System verification
- Multi-operator LAN test with at least two independent Companion instances and simultaneous browser sessions.
## Key decisions captured
- Use Bitfocus Companion custom module, not Stream Deck SDK.
- Browser-controlled model is the primary integration mode for this phase.
- Backend rejection remains authoritative for role/policy constraints.
- Discovery endpoints are included.
- No admin/config actions in Companion scope.
