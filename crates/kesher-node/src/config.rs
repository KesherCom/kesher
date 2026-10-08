//! `/etc/kesher/node.toml`: everything a node needs to join the intercom.
//! See deploy/node/node.toml.example for the documented template.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_CONFIG_PATH: &str = "/etc/kesher/node.toml";
pub const DEFAULT_STATE_DIR: &str = "/var/lib/kesher-node";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Talk while the talk button is held.
    Ptt,
    /// Open mic with silence suppression; the talk button mutes.
    AlwaysOn,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Base URL of the Kesher server, e.g. "https://192.168.1.10:8443".
    /// Unset (or "auto"): find it on the LAN via mDNS.
    #[serde(default)]
    pub server: Option<String>,
    /// Name shown in the user list (no spaces). Default: the hostname.
    /// Only used together with `role`.
    #[serde(default)]
    pub name: Option<String>,
    /// Role ID (admin area -> roles) to log in with directly. Unset: the
    /// node pairs itself and is approved in the admin area (Stations),
    /// which also sets its name, role and mode.
    #[serde(default)]
    pub role: Option<String>,
    /// Talk mode when `role` is set (paired nodes get it from the server).
    #[serde(default = "default_mode")]
    pub mode: Mode,
    /// Replace another active session of the same role instead of waiting
    /// for it to end.
    #[serde(default)]
    pub takeover: bool,
    /// Accept self-signed TLS certificates (https servers on the LAN).
    #[serde(default)]
    pub tls_insecure: bool,
    /// Where the session token is kept across restarts.
    #[serde(default)]
    pub state_dir: Option<PathBuf>,
    #[serde(default)]
    pub audio: AudioConfig,
    #[serde(default)]
    pub rooms: RoomsConfig,
    #[serde(default)]
    pub gpio: GpioConfig,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioConfig {
    /// Sound card for the mic: part of its name as listed by
    /// `kesher-node devices` (e.g. "USB"), or an exact ALSA device name.
    /// Empty: system default.
    #[serde(default)]
    pub input: Option<String>,
    /// Sound card for the headphones; same rules as `input`.
    #[serde(default)]
    pub output: Option<String>,
    /// Mic gain in dB (-40..+24).
    #[serde(default)]
    pub input_gain_db: f32,
    /// Noise gate threshold in dBFS (-72..-12); unset = gate off.
    #[serde(default)]
    pub gate_db: Option<f32>,
}

/// Party lines; empty lists keep the role's default party line.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoomsConfig {
    #[serde(default)]
    pub listen: Vec<String>,
    #[serde(default)]
    pub talk: Vec<String>,
}

/// Header pins by BCM number (the "GPIO17" names), not physical pin number.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GpioConfig {
    /// Talk button between this pin and GND (internal pull-up is used).
    #[serde(default)]
    pub talk_button: Option<u32>,
    /// LED (with resistor) from this pin to GND: on while talking, blinks
    /// while the node is not connected.
    #[serde(default)]
    pub talk_led: Option<u32>,
}

fn default_mode() -> Mode {
    Mode::Ptt
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let cfg: Config = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn validate(&self) -> Result<(), String> {
        if let Some(server) = self.server_url() {
            let url = url::Url::parse(server).map_err(|e| format!("server {server:?}: {e}"))?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err(format!("server {server:?}: expected http://host:port or https://host"));
            }
        }
        if self.role.as_deref().is_some_and(|r| r.trim().is_empty()) {
            return Err("role must not be empty (leave it out to pair in the admin area)".into());
        }
        if self.username().chars().any(char::is_whitespace) {
            return Err(format!("name {:?} must not contain spaces", self.username()));
        }
        if !(-40.0..=24.0).contains(&self.audio.input_gain_db) {
            return Err("audio.input_gain_db must be between -40 and 24".into());
        }
        if let Some(db) = self.audio.gate_db {
            if !(-72.0..=-12.0).contains(&db) {
                return Err("audio.gate_db must be between -72 and -12".into());
            }
        }
        if self.role.is_some() && self.mode == Mode::Ptt && self.gpio.talk_button.is_none() {
            log::warn!("mode = \"ptt\" without gpio.talk_button: this node can listen but not talk");
        }
        Ok(())
    }

    /// The configured server URL; None means "find it on the LAN".
    pub fn server_url(&self) -> Option<&str> {
        self.server.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "auto")
    }

    /// The configured role; None means "pair and wait for approval".
    pub fn role(&self) -> Option<&str> {
        self.role.as_deref().map(str::trim).filter(|r| !r.is_empty())
    }

    /// The login name: `name`, else the hostname.
    pub fn username(&self) -> String {
        if let Some(name) = self.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            return name.to_string();
        }
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "kesher-node".to_string())
    }

    pub fn state_dir(&self) -> PathBuf {
        self.state_dir
            .clone()
            .or_else(|| std::env::var_os("STATE_DIRECTORY").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from(DEFAULT_STATE_DIR))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_example_config() {
        let text = include_str!("../../../deploy/node/node.toml.example");
        let cfg: Config = toml::from_str(text).expect("example parses");
        cfg.validate().expect("example is valid");
        assert_eq!(cfg.mode, Mode::Ptt);
    }

    #[test]
    fn rejects_bad_server_and_names() {
        let base = |extra: &str| format!("server = \"http://10.0.0.1:8080\"\nrole = \"stage\"\n{extra}");
        let ok: Config = toml::from_str(&base("name = \"pi-1\"")).unwrap();
        assert!(ok.validate().is_ok());
        let spaced: Config = toml::from_str(&base("name = \"pi 1\"")).unwrap();
        assert!(spaced.validate().is_err());
        let bad: Config = toml::from_str("server = \"10.0.0.1\"\nrole = \"x\"").unwrap();
        assert!(bad.validate().is_err());
        assert!(toml::from_str::<Config>(&base("unknown_key = 1")).is_err());
    }

    #[test]
    fn empty_config_means_discover_and_pair() {
        let cfg: Config = toml::from_str("").unwrap();
        cfg.validate().unwrap();
        assert_eq!(cfg.server_url(), None);
        assert_eq!(cfg.role(), None);
        let auto: Config = toml::from_str("server = \"auto\"").unwrap();
        assert_eq!(auto.server_url(), None);
    }
}
