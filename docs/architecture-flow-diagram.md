# Kesher Architecture & Information Flow

This document visualizes how information flows across the system, including the full operator loop:
`HW/browser -> frontend -> backend -> frontend -> HW`, plus related companion/telegram/proxy paths.

## 1) System architecture and flow map (detailed)

```mermaid
flowchart LR
  %% ===============================
  %% Client side (hardware + browser)
  %% ===============================
  subgraph HW["Operator Hardware"]
    MIC["Microphone"]
    OUT["Headphones / Speakers"]
    KBD["Keyboard / PTT control"]
  end

  subgraph BROWSER["Browser (secure context)"]
    FE["React app orchestration\nweb/src/App.tsx"]
    GUM["getUserMedia() + device selection\n(input gain / meter)"]
    LPC["Local RTCPeerConnection"]
    LWS["WebSocket /ws?token=..."]
    AUDIO["Remote audio elements\n(per-track gain + output routing)"]
  end

  %% ===============================
  %% Optional localhost desktop proxy
  %% ===============================
  subgraph PROXY["Optional desktop-proxy (kesher-desktop-proxy repo)"]
    DPHTTP["HTTP reverse proxy\n127.0.0.1 -> upstream"]
    DPWS["WS reverse proxy\n/ws passthrough"]
    DPTLS["Custom trust / pins / CA file"]
  end

  %% ===============================
  %% Backend internals
  %% ===============================
  subgraph BACKEND["Backend (Go server)"]
    API["HTTP handlers\n/api/login, /api/bootstrap,\n/admin, /api/public-bootstrap"]
    WSG["WS gateway\nhandleWS()"]
    SESS["SessionManager\n(token -> user/role)"]
    HUB["Hub\npresence + routed events\n(party-line/direct/broadcast)"]
    MEDIA["MediaManager\nWebRTC peer map + RTP forwarding"]
    DECIDE{"Audio route priority\nfor each source:\n1) direct target active?\n2) broadcast party-lines active?\n3) talk->listen overlap"}
    TELE["TelegramBot\npolling/webhook + chat bridge"]
  end

  %% ===============================
  %% Persistence and external systems
  %% ===============================
  DB[("SQLite Store\nroles / party-lines / groups /\nusers / mappings / policy cache")]
  TG["Telegram API / chats"]

  subgraph COMP["Bitfocus Companion path"]
    MOD["Companion module\n(companion-module-kesher repo)"]
    CDISC["GET /api/companion/discovery?roleId=..."]
    CWS["WS /api/companion/ws?roleId=..."]
  end

  OTHER["Other operators\n(browser clients)"]

  %% ===============================
  %% Primary operator path
  %% ===============================
  MIC -->|"raw mic audio"| GUM
  KBD -->|"PTT/signal/chat UI actions"| FE
  GUM -->|"processed local mic track"| LPC
  FE -->|"create/join realtime session"| LWS
  FE -->|"login/bootstrap REST"| API
  API --> SESS
  API <--> DB
  LWS --> WSG
  WSG --> SESS
  WSG --> HUB
  WSG --> MEDIA
  HUB <--> DB
  MEDIA <--> DB
  MEDIA --> DECIDE
  DECIDE -->|"attach/remove source tracks\n+ renegotiate offer"| MEDIA
  MEDIA -->|"webrtc_offer / ice_candidate"| WSG
  WSG -->|"WS outbound"| LWS
  LWS -->|"setRemoteDescription,\ncreateAnswer, addIceCandidate"| LPC
  LPC -->|"remote tracks"| AUDIO
  AUDIO --> OUT

  %% Control/event fanout
  FE -->|"chat/signal/voice_state,\nset_party_line_matrix"| LWS
  LWS --> WSG
  WSG -->|"authorize by role + scope"| HUB
  HUB -->|"presence + chat + signal + voice_state"| WSG
  WSG -->|"WS fanout"| OTHER
  HUB -->|"presence updates"| WSG
  WSG -->|"presence list"| LWS
  LWS --> FE

  %% Desktop proxy alternate transport path
  BROWSER -. "Alt transport: frontend served via backend through localhost proxy" .-> DPHTTP
  BROWSER -. "Alt WS path" .-> DPWS
  DPHTTP --> DPTLS
  DPWS --> DPTLS
  DPTLS --> API
  DPTLS --> WSG

  %% Companion integration path
  MOD --> CDISC
  CDISC --> API
  API --> DB
  MOD --> CWS
  CWS --> WSG
  WSG --> HUB
  HUB -->|"companion_command"| WSG
  WSG -->|"command applied in browser client"| LWS
  HUB -->|"companion_state snapshots\n(bound/presence/reply target/signal)"| CWS
  CWS --> MOD

  %% Telegram bridge path
  HUB -->|"chat hook (party-line chat)"| TELE
  TELE -->|"sendMessage"| TG
  TG -->|"incoming message\n(polling/webhook)"| TELE
  TELE -->|"SendChatToRoom"| HUB
```

## 2) Primary realtime operator loop (sequence detail)

```mermaid
sequenceDiagram
  autonumber
  participant HW as HW (Mic/Headset/PTT)
  participant FE as Frontend (App.tsx)
  participant WS as Backend WS handler
  participant HUB as Hub
  participant MM as MediaManager
  participant DB as SQLite Store
  participant PEER as Other clients

  HW->>FE: Mic input + PTT/chat/signal interactions
  FE->>WS: POST /api/login, GET /api/bootstrap
  WS->>DB: Validate role, upsert user, load roles/party-lines/groups/users
  DB-->>WS: Bootstrap data + session token context
  FE->>WS: Open /ws?token=...
  WS->>MM: EnsurePeer(token,user)
  FE->>WS: webrtc_ready
  WS->>MM: EnsureNegotiation + SyncRouting
  MM-->>WS: webrtc_offer (+ ice candidates)
  WS-->>FE: WS webrtc_offer / webrtc_ice_candidate
  FE->>WS: webrtc_answer / webrtc_ice_candidate
  FE->>WS: set_party_line_matrix + initial voice_state
  WS->>DB: Policy checks (party-line sender/receiver, groups, forced-listen)
  WS->>HUB: Update presence + route control events
  HUB-->>PEER: presence/chat/signal/voice_state fanout
  FE->>WS: voice_state (ptt_start/stop or always_on)
  WS->>MM: SetDirectTargetActive / SetBroadcastGroupActive / SyncRouting
  MM->>MM: Routing priority: direct > broadcast > talk/listen overlap
  MM-->>WS: Renegotiation offers as routing changes
  WS-->>FE: Updated offers + remote ICE + routed events
  FE-->>HW: Remote audio playback to selected output device
```

## 3) Companion control bridge (sequence detail)

```mermaid
sequenceDiagram
  autonumber
  participant MOD as Companion module
  participant API as Backend companion endpoints
  participant HUB as Hub
  participant FE as Target browser session

  MOD->>API: GET /api/companion/discovery?roleId=...
  API-->>MOD: Allowed party-lines/users/broadcast groups for role
  MOD->>API: WS /api/companion/ws?roleId=...
  API-->>MOD: companion_state (bound, presence, reply target, signal state)
  MOD->>API: command payload (set_voice_mode / ptt / signal / party-line matrix)
  API->>HUB: Resolve latest token for roleId + SendToToken(companion_command)
  HUB-->>FE: companion_command via operator WS
  FE-->>API: command effect reflected via normal WS events/presence
  API-->>MOD: companion_command_result + refreshed companion_state
```

## 4) Telegram chat bridge (sequence detail)

```mermaid
sequenceDiagram
  autonumber
  participant TG as Telegram
  participant BOT as TelegramBot
  participant DB as SQLite Store
  participant HUB as Hub
  participant FE as Browser clients

  TG->>BOT: Incoming message (polling getUpdates or webhook)
  BOT->>DB: Resolve chatId -> mapped party-line
  DB-->>BOT: Party-line mapping
  BOT->>HUB: SendChatToRoom(mapped party-line)
  HUB-->>FE: chat routed to listeners
  FE->>HUB: party-line chat event from operator
  HUB->>BOT: chat hook callback
  BOT->>DB: Find party-line -> telegram mappings
  BOT->>TG: sendMessage to mapped chats
```
