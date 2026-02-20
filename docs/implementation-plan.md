# Live Production Intercom (Church) - Detailed Implementation Plan
## Problem statement
Build an on-premise, web-based intercom application for a single church organization that supports low-latency voice communication, chat, and signaling across production roles, with flexible routing (1:1, rooms/groups, and broadcast groups spanning multiple rooms/roles).
## Current state and validated scope
Validated requirements:
* Domain: church live multimedia production
* Organization model: single org, on-prem only (no cloud dependency)
* Users: all involved in production (technical team, operators, pastor as needed)
* V1 core: voice + chat + signals; room/group communication; broadcast groups; person-to-person communication; role-based routing
* Communication behavior: push-to-talk, always-on talk, listen-only, whisper/private channels
* Scale: 30-50 concurrent users
* Latency target: perceived real-time, ideally 500ms-1s end-to-end or better
* Audio quality: intelligible speech prioritized over fidelity
* Platform: web app usable on desktop and mobile browsers
* Integrations: none required in V1; Companion/Stream Deck and vMix tally deferred
* AuthN/AuthZ: local accounts initially; RBAC with initially simplified self-assigned role flow
* Compliance/ops: GDPR-conscious, no explicit audit-log/retention requirement
Technical decisions (locked):
* Backend: Go
* Frontend: React + TypeScript (Vite)
* Realtime signaling: native WebSocket implementation
* Media layer: embedded/self-hosted WebRTC SFU library in-process with backend (no external media server runtime)
* Database: SQLite
* Cache/presence: in-memory state (single-node V1)
* API style: REST
* Deployment: Docker Compose on Linux PC
* TLS/proxy: no external reverse proxy; TLS termination inside Go server
* Auth flow: username + role selection at login for V1
* Testing strategy: unit-test focused
* Observability: structured logs only for V1
* Repository shape: monorepo with separate backend/frontend subdirectories
* Architecture bias: clean architecture with pragmatic delivery
Critical recommendations applied:
* Keep username+role login for rapid V1, but add optional admin-controlled role allowlist and ephemeral session TTL.
* For TLS on on-prem LAN, run dual mode: HTTP default for trusted isolated LAN, optional HTTPS with locally trusted certs.
Resolved scope constraints:
* Reliability goal: stable during live events
* Recording: excluded from V1
* On-prem target host: Linux PC
* Delivery constraints: ASAP, no fixed timeline, side-project
* Role self-assignment: unrestricted for now (with optional guardrails feature flag)

