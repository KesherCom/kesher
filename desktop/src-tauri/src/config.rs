use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;
use tauri::Url;
const CONFIG_FILE_NAME: &str = "desktop-config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopConfig {
    pub server_url: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve app config dir: {error}"))?;

    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("failed to create app config dir: {error}"))?;

    Ok(app_dir.join(CONFIG_FILE_NAME))
}

fn read_config(app: &AppHandle) -> Result<DesktopConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(DesktopConfig::default());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read desktop config: {error}"))?;

    serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse desktop config: {error}"))
}

fn write_config(app: &AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("failed to serialize desktop config: {error}"))?;

    fs::write(path, raw).map_err(|error| format!("failed to write desktop config: {error}"))
}

fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("server URL must not be empty".to_string());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };

    let parsed = Url::parse(&candidate).map_err(|error| format!("invalid server URL: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("server URL must use http or https".to_string());
    }

    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

#[tauri::command]
pub fn get_server_url(app: AppHandle) -> Result<String, String> {
    let stored = read_config(&app)?.server_url;
    if stored.trim().is_empty() {
        return Ok(String::new());
    }
    normalize_server_url(&stored)
}

#[tauri::command]
pub fn set_server_url(app: AppHandle, server_url: String) -> Result<(), String> {
    let normalized = normalize_server_url(&server_url)?;
    let mut config = read_config(&app)?;
    config.server_url = normalized;
    write_config(&app, &config)
}
