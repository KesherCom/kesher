use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8080";
const CONFIG_FILE_NAME: &str = "desktop-config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopConfig {
    pub server_url: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER_URL.to_string(),
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

#[tauri::command]
pub fn get_server_url(app: AppHandle) -> Result<String, String> {
    Ok(read_config(&app)?.server_url)
}

#[tauri::command]
pub fn set_server_url(app: AppHandle, server_url: String) -> Result<(), String> {
    let trimmed = server_url.trim();
    if trimmed.is_empty() {
        return Err("server URL must not be empty".to_string());
    }

    let parsed = trimmed
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid server URL: {error}"))?;

    let mut config = read_config(&app)?;
    config.server_url = parsed.to_string();
    write_config(&app, &config)
}
