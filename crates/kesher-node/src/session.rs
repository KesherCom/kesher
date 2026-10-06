//! The node's control loop: log in, hold the `/ws` connection, run the
//! audio engine on the UDP endpoint the server announces, and translate the
//! talk button into voice state. Reconnects forever; a node has no one to
//! click "retry".
//!
//! Same protocol as the desktop app in performance mode
//! (packages/client-core, useIntercomSession.ts):
//!   POST /api/login {username, roleId}            -> token
//!   GET  /ws?token=..&transport=native            -> native_audio_endpoint
//!   set_room_matrix / voice_state over the socket; audio over KSHR/UDP.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use kesher_audio::native::{self as engine, NativeAudioState, NativeStatsSnapshot, StartNativeParams};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::config::{Config, Mode};
use crate::devices;
use crate::gpio::{Led, LedState};
use crate::net::{self, Ws, WsError};

const PING_EVERY: Duration = Duration::from_secs(15);
/// No frame (not even a pong) for this long: the connection is dead.
const SERVER_SILENT_LIMIT: Duration = Duration::from_secs(45);
/// Output callbacks stalled this long: the sound card is gone (unplugged).
const DEVICE_STALL_LIMIT: Duration = Duration::from_secs(3);
const ENGINE_RETRY: Duration = Duration::from_secs(5);
const STATS_EVERY: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(10);

type Sink = SplitSink<Ws, Message>;

/// Login result kept in the state dir, so a restarted node resumes its
/// session instead of colliding with it ("role in use").
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedSession {
    server: String,
    role: String,
    username: String,
    token: String,
    user_id: String,
}

enum Exit {
    Shutdown,
    Retry(String),
    RetryAfter(String, Duration),
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    data: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    host: String,
    port: u16,
    token: String,
    token_hash: u32,
    #[serde(default)]
    frame_duration_ms: Option<f32>,
    #[serde(default)]
    protocol_version: Option<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresenceEntry {
    user_id: String,
    // Go encodes empty slices as null.
    #[serde(default)]
    listen_rooms: Option<Vec<String>>,
    #[serde(default)]
    talk_rooms: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    token: String,
    user: LoginUser,
}

#[derive(Deserialize)]
struct LoginUser {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginConflict {
    #[serde(default)]
    conflict_username: String,
}

/// Per-connection state; reset on every reconnect.
struct Conn {
    listen_rooms: Vec<String>,
    talk_rooms: Vec<String>,
    sent_voice: Option<&'static str>,
    endpoint: Option<Endpoint>,
    engine_retry_at: Option<Instant>,
    last_render: (u64, Instant),
    last_rx: Instant,
    next_ping: Instant,
    next_stats: Instant,
    stats_base: NativeStatsSnapshot,
}

pub struct Node {
    cfg: Config,
    base: Url,
    username: String,
    audio: Arc<NativeAudioState>,
    led: Led,
    session: Option<SavedSession>,
    button_down: bool,
    /// Always-on mode: the talk button toggles this.
    muted: bool,
}

impl Node {
    pub fn new(cfg: Config, led: Led) -> Self {
        let base = Url::parse(&cfg.server).expect("validated in Config::load");
        let username = cfg.username();
        let mut node = Self {
            cfg,
            base,
            username,
            audio: Arc::new(NativeAudioState::default()),
            led,
            session: None,
            button_down: false,
            muted: false,
        };
        node.session = node.load_session();
        node
    }

    pub async fn run(mut self, mut talk_rx: mpsc::UnboundedReceiver<bool>, mut shutdown: watch::Receiver<bool>) {
        log::info!(
            "kesher-node {}: {} as {:?} (role {:?}, mode {:?})",
            crate::VERSION,
            self.cfg.server,
            self.username,
            self.cfg.role,
            self.cfg.mode
        );
        let mut backoff = Duration::from_secs(1);
        loop {
            self.led.set(LedState::Offline);
            let started = Instant::now();
            let exit = self.serve(&mut talk_rx, &mut shutdown).await;
            engine::stop_engine(&self.audio).await;
            let wait = match exit {
                Exit::Shutdown => {
                    self.logout().await;
                    self.led.set(LedState::Off);
                    return;
                }
                Exit::Retry(why) => {
                    log::warn!("{why}; reconnecting");
                    if started.elapsed() > Duration::from_secs(30) {
                        backoff = Duration::from_secs(1);
                    }
                    let wait = backoff;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    wait
                }
                Exit::RetryAfter(why, wait) => {
                    log::warn!("{why}; retrying in {}s", wait.as_secs());
                    wait
                }
            };
            // Keep tracking the button while offline.
            let deadline = tokio::time::sleep(wait);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    Some(down) = talk_rx.recv() => self.on_button(down),
                    _ = shutdown.changed() => {
                        self.logout().await;
                        self.led.set(LedState::Off);
                        return;
                    }
                }
            }
        }
    }

    async fn serve(&mut self, talk_rx: &mut mpsc::UnboundedReceiver<bool>, shutdown: &mut watch::Receiver<bool>) -> Exit {
        let ws = match self.open_ws().await {
            Ok(ws) => ws,
            Err(exit) => return exit,
        };
        log::info!("connected to {}", self.cfg.server);
        let (mut sink, mut stream) = ws.split();
        let now = Instant::now();
        let mut conn = Conn {
            listen_rooms: Vec::new(),
            talk_rooms: Vec::new(),
            sent_voice: None,
            endpoint: None,
            engine_retry_at: None,
            last_render: (0, now),
            last_rx: now,
            next_ping: now + PING_EVERY,
            next_stats: now + STATS_EVERY,
            stats_base: NativeStatsSnapshot::default(),
        };
        self.update_led();
        let rooms = &self.cfg.rooms;
        if !rooms.listen.is_empty() || !rooms.talk.is_empty() {
            let matrix = json!({ "listenRoomIds": rooms.listen, "talkRoomIds": rooms.talk });
            if let Err(e) = send(&mut sink, "set_room_matrix", matrix).await {
                return Exit::Retry(e);
            }
        }
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                msg = stream.next() => {
                    conn.last_rx = Instant::now();
                    match msg {
                        None | Some(Ok(Message::Close(_))) => return Exit::Retry("server closed the connection".into()),
                        Some(Err(e)) => return Exit::Retry(format!("connection lost: {e}")),
                        Some(Ok(Message::Text(text))) => {
                            if let Some(exit) = self.on_message(&text, &mut conn, &mut sink).await {
                                return exit;
                            }
                        }
                        Some(Ok(_)) => {}
                    }
                }
                Some(down) = talk_rx.recv() => {
                    self.on_button(down);
                    if let Err(e) = self.sync_voice(&mut conn, &mut sink).await {
                        return Exit::Retry(e);
                    }
                }
                _ = tick.tick() => {
                    if let Some(exit) = self.on_tick(&mut conn, &mut sink).await {
                        return exit;
                    }
                }
                _ = shutdown.changed() => {
                    // 1001 "going away": what the server expects from a leaving client.
                    let bye = CloseFrame { code: CloseCode::Away, reason: "node stopping".into() };
                    let _ = sink.send(Message::Close(Some(bye))).await;
                    return Exit::Shutdown;
                }
            }
        }
    }

    async fn on_message(&mut self, text: &str, conn: &mut Conn, sink: &mut Sink) -> Option<Exit> {
        let Ok(env) = serde_json::from_str::<Envelope>(text) else {
            return None;
        };
        match env.kind.as_str() {
            "native_audio_endpoint" => match serde_json::from_value::<Endpoint>(env.data) {
                Ok(ep) => {
                    conn.endpoint = Some(ep);
                    self.start_engine(conn).await;
                }
                Err(e) => log::warn!("bad native_audio_endpoint: {e}"),
            },
            "presence" => {
                let Some(user_id) = self.session.as_ref().map(|s| s.user_id.clone()) else {
                    return None;
                };
                let entries: Vec<PresenceEntry> = serde_json::from_value(env.data).unwrap_or_default();
                if let Some(me) = entries.into_iter().find(|e| e.user_id == user_id) {
                    let listen = me.listen_rooms.unwrap_or_default();
                    let talk = me.talk_rooms.unwrap_or_default();
                    if listen != conn.listen_rooms || talk != conn.talk_rooms {
                        log::info!("party lines: listen {listen:?}, talk {talk:?}");
                        if talk.is_empty() {
                            log::warn!("no talk party line for this role; the node can only listen");
                        }
                        conn.listen_rooms = listen;
                        conn.talk_rooms = talk;
                    }
                    if let Err(e) = self.sync_voice(conn, sink).await {
                        return Some(Exit::Retry(e));
                    }
                }
            }
            "session_revoked" => {
                let reason = env.data.get("reason").and_then(|r| r.as_str()).unwrap_or("").to_string();
                self.forget_session();
                // Usually someone else took over this role; give them room.
                return Some(Exit::RetryAfter(
                    format!("session ended by the server ({})", if reason.is_empty() { "no reason" } else { &reason }),
                    Duration::from_secs(30),
                ));
            }
            _ => {}
        }
        None
    }

    async fn on_tick(&mut self, conn: &mut Conn, sink: &mut Sink) -> Option<Exit> {
        let now = Instant::now();
        if now.duration_since(conn.last_rx) > SERVER_SILENT_LIMIT {
            return Some(Exit::Retry("no response from the server".into()));
        }
        if now >= conn.next_ping {
            conn.next_ping = now + PING_EVERY;
            if let Err(e) = sink.send(Message::Ping(Default::default())).await {
                return Some(Exit::Retry(format!("connection lost: {e}")));
            }
        }
        match engine::stats_snapshot(&self.audio) {
            Some(stats) => {
                // Device watchdog: a vanished USB headset stops the output
                // callbacks without an error the engine could act on.
                if stats.render_calls != conn.last_render.0 {
                    conn.last_render = (stats.render_calls, now);
                } else if now.duration_since(conn.last_render.1) > DEVICE_STALL_LIMIT {
                    log::warn!("sound card stopped delivering audio (unplugged?); restarting audio");
                    engine::stop_engine(&self.audio).await;
                    conn.engine_retry_at = Some(now + Duration::from_secs(1));
                }
                if now >= conn.next_stats {
                    conn.next_stats = now + STATS_EVERY;
                    log_stats(&conn.stats_base, &stats);
                    conn.stats_base = stats;
                }
            }
            None => {
                if conn.endpoint.is_some() && conn.engine_retry_at.is_some_and(|t| now >= t) {
                    self.start_engine(conn).await;
                }
            }
        }
        None
    }

    async fn start_engine(&mut self, conn: &mut Conn) {
        let Some(ep) = conn.endpoint.clone() else { return };
        engine::stop_engine(&self.audio).await;
        match self.try_start_engine(&ep).await {
            Ok(()) => {
                let now = Instant::now();
                conn.engine_retry_at = None;
                conn.last_render = (0, now);
                conn.next_stats = now + STATS_EVERY;
                conn.stats_base = NativeStatsSnapshot::default();
                self.apply_mic();
            }
            Err(e) => {
                log::error!("audio: {e}");
                conn.engine_retry_at = Some(Instant::now() + ENGINE_RETRY);
            }
        }
    }

    async fn try_start_engine(&self, ep: &Endpoint) -> Result<(), String> {
        let input = devices::resolve(self.cfg.audio.input.as_deref(), true)?;
        let output = devices::resolve(self.cfg.audio.output.as_deref(), false)?;
        let params = StartNativeParams {
            server_host: ep.host.clone(),
            server_port: ep.port,
            session_token: ep.token.clone(),
            token_hash: ep.token_hash,
            input_device_id: input,
            output_device_id: output,
            protocol_version: ep.protocol_version,
            frame_duration_ms: ep.frame_duration_ms,
            audio_backend: None,
        };
        let info = engine::start_engine(params, &self.audio, None).await?;
        log::info!(
            "audio running: in {} ({:?} ms), out {} ({:?} ms), {} ms frames, KSHR v{}",
            info.input.device,
            info.input.period_ms,
            info.output.device,
            info.output.period_ms,
            info.frame_ms,
            info.protocol_version
        );
        let audio = &self.cfg.audio;
        engine::set_input_gain(&self.audio, 10f32.powf(audio.input_gain_db / 20.0));
        match audio.gate_db {
            Some(db) => engine::set_audio_gate(&self.audio, true, db),
            None => engine::set_audio_gate(&self.audio, false, -52.0),
        }
        Ok(())
    }

    fn on_button(&mut self, down: bool) {
        if down == self.button_down {
            return;
        }
        self.button_down = down;
        if self.cfg.mode == Mode::AlwaysOn && down {
            self.muted = !self.muted;
            log::info!("mic {}", if self.muted { "muted" } else { "open" });
        }
        self.apply_mic();
    }

    fn talking(&self) -> bool {
        match self.cfg.mode {
            Mode::Ptt => self.button_down,
            Mode::AlwaysOn => !self.muted,
        }
    }

    /// Engine mic follows the talk state; silence suppression only for an
    /// open mic (as in the desktop app).
    fn apply_mic(&self) {
        engine::set_vad(&self.audio, self.cfg.mode == Mode::AlwaysOn);
        engine::set_mic_active(&self.audio, self.talking());
        self.update_led();
    }

    fn update_led(&self) {
        self.led.set(if self.talking() { LedState::On } else { LedState::Off });
    }

    /// Tells the server whether this node talks; it routes our audio only
    /// while it does. Needs a talk party line as target.
    async fn sync_voice(&mut self, conn: &mut Conn, sink: &mut Sink) -> Result<(), String> {
        let desired = match (self.cfg.mode, self.talking()) {
            (Mode::Ptt, true) => "ptt_start",
            (Mode::Ptt, false) => "ptt_stop",
            (Mode::AlwaysOn, true) => "always_on",
            (Mode::AlwaysOn, false) => "always_off",
        };
        if conn.sent_voice == Some(desired) || (conn.sent_voice.is_none() && desired == "ptt_stop") {
            return Ok(());
        }
        let Some(room) = conn.talk_rooms.first().cloned() else {
            return Ok(());
        };
        send(sink, "voice_state", json!({ "scope": "room", "targetId": room, "body": desired })).await?;
        conn.sent_voice = Some(desired);
        Ok(())
    }

    // ── Login and session persistence ──────────────────────────────────

    async fn open_ws(&mut self) -> Result<Ws, Exit> {
        let insecure = self.cfg.tls_insecure;
        if let Some(saved) = self.session.clone() {
            match net::connect_ws(&self.base, &saved.token, insecure).await {
                Ok(ws) => return Ok(ws),
                Err(WsError::Unauthorized) => {
                    log::info!("saved session has expired; logging in again");
                    self.forget_session();
                }
                Err(WsError::Other(e)) => return Err(Exit::Retry(e)),
            }
        }
        let token = self.login().await?;
        net::connect_ws(&self.base, &token, insecure).await.map_err(|e| match e {
            WsError::Unauthorized => Exit::Retry("server rejected the new session".into()),
            WsError::Other(e) => Exit::Retry(e),
        })
    }

    async fn login(&mut self) -> Result<String, Exit> {
        let body = json!({ "username": self.username, "roleId": self.cfg.role });
        let insecure = self.cfg.tls_insecure;
        let (mut status, mut text) = net::post_json(&self.base, "/api/login", &body, None, insecure)
            .await
            .map_err(|e| Exit::Retry(format!("login: {e}")))?;
        if status == 409 {
            let holder = serde_json::from_str::<LoginConflict>(&text)
                .map(|c| c.conflict_username)
                .unwrap_or_default();
            if !self.cfg.takeover {
                return Err(Exit::RetryAfter(
                    format!(
                        "role {:?} is in use by {holder:?} (set takeover = true to replace that session)",
                        self.cfg.role
                    ),
                    Duration::from_secs(15),
                ));
            }
            log::warn!("role {:?} is in use by {holder:?}; taking it over", self.cfg.role);
            (status, text) = net::post_json(&self.base, "/api/login/takeover", &body, None, insecure)
                .await
                .map_err(|e| Exit::Retry(format!("takeover: {e}")))?;
        }
        if status == 400 {
            // Unknown role or invalid name: retrying fast will not help.
            return Err(Exit::RetryAfter(
                format!("login rejected: {} (check role and name in the config)", text.trim()),
                Duration::from_secs(60),
            ));
        }
        if status != 200 {
            return Err(Exit::Retry(format!("login failed: HTTP {status} {}", text.trim())));
        }
        let resp: LoginResponse =
            serde_json::from_str(&text).map_err(|e| Exit::Retry(format!("login: unexpected response: {e}")))?;
        log::info!("logged in as {:?}", self.username);
        let saved = SavedSession {
            server: self.cfg.server.clone(),
            role: self.cfg.role.clone(),
            username: self.username.clone(),
            token: resp.token.clone(),
            user_id: resp.user.id,
        };
        self.save_session(&saved);
        self.session = Some(saved);
        Ok(resp.token)
    }

    /// Frees the role right away on a clean stop (systemctl stop, reboot),
    /// so the next start does not wait for the server's disconnect timeout.
    async fn logout(&mut self) {
        let Some(saved) = self.session.take() else { return };
        let result = net::post_json(&self.base, "/api/logout", &json!({}), Some(&saved.token), self.cfg.tls_insecure).await;
        match result {
            Ok((200, _)) => log::info!("logged out"),
            Ok((status, _)) => log::debug!("logout: HTTP {status}"),
            Err(e) => log::debug!("logout: {e}"),
        }
        self.forget_session();
    }

    fn session_path(&self) -> PathBuf {
        self.cfg.state_dir().join("session.json")
    }

    fn load_session(&self) -> Option<SavedSession> {
        let text = std::fs::read_to_string(self.session_path()).ok()?;
        let saved: SavedSession = serde_json::from_str(&text).ok()?;
        // A config change (other server, role or name) means a new login.
        (saved.server == self.cfg.server && saved.role == self.cfg.role && saved.username == self.username).then_some(saved)
    }

    fn save_session(&self, saved: &SavedSession) {
        let path = self.session_path();
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let text = serde_json::to_string(saved).map_err(std::io::Error::other)?;
            write_private(&path, text.as_bytes())
        };
        if let Err(e) = write() {
            log::debug!("could not save session to {}: {e}", path.display());
        }
    }

    fn forget_session(&mut self) {
        self.session = None;
        let _ = std::fs::remove_file(self.session_path());
    }
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(data)
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, data)
}

async fn send(sink: &mut Sink, kind: &str, data: serde_json::Value) -> Result<(), String> {
    let text = json!({ "type": kind, "data": data }).to_string();
    sink.send(Message::Text(text.into())).await.map_err(|e| format!("connection lost: {e}"))
}

fn log_stats(a: &NativeStatsSnapshot, b: &NativeStatsSnapshot) {
    log::info!(
        "audio last minute: sent {} rx {} lost/concealed {} fec {} late {} underruns {} | jitter buffer {:.1} ms, sources {}",
        b.tx_packets - a.tx_packets,
        b.rx_packets - a.rx_packets,
        b.concealed - a.concealed,
        b.fec_recovered - a.fec_recovered,
        b.late_packets - a.late_packets,
        b.jitter_underruns - a.jitter_underruns,
        b.target_ms,
        b.active_sources
    );
}
