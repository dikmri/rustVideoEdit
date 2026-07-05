//! `save_project` / `load_project` / `read_settings` / `write_settings`(DESIGN.md §5)。
//! 中身は解釈しない透過 JSON 文字列として扱う。

use std::path::Path;

use tauri::command;
use tracing::{error, info};

use crate::paths;

#[command]
pub fn save_project(path: String, json: String) -> Result<(), String> {
    info!(target: "commands::project", "cmd=save_project path={path}");

    if let Some(parent) = Path::new(&path).parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            let msg = format!("親ディレクトリの作成に失敗しました: {e}");
            error!(target: "commands::project", "cmd=save_project err={msg}");
            return Err(msg);
        }
    }

    std::fs::write(&path, json).map_err(|e| {
        let msg = format!("プロジェクトの保存に失敗しました: {e}");
        error!(target: "commands::project", "cmd=save_project err={msg}");
        msg
    })?;

    info!(target: "commands::project", "cmd=save_project ok");
    Ok(())
}

#[command]
pub fn load_project(path: String) -> Result<String, String> {
    info!(target: "commands::project", "cmd=load_project path={path}");

    let content = std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("プロジェクトの読込に失敗しました: {e}");
        error!(target: "commands::project", "cmd=load_project err={msg}");
        msg
    })?;

    info!(target: "commands::project", "cmd=load_project ok");
    Ok(content)
}

#[command]
pub fn read_settings() -> Result<String, String> {
    info!(target: "commands::project", "cmd=read_settings");

    let path = paths::settings_path();
    if !path.is_file() {
        info!(target: "commands::project", "cmd=read_settings ok (default)");
        return Ok("{}".to_string());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| {
        let msg = format!("設定の読込に失敗しました: {e}");
        error!(target: "commands::project", "cmd=read_settings err={msg}");
        msg
    })?;

    info!(target: "commands::project", "cmd=read_settings ok");
    Ok(content)
}

#[command]
pub fn write_settings(json: String) -> Result<(), String> {
    info!(target: "commands::project", "cmd=write_settings");

    let path = paths::settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    std::fs::write(&path, json).map_err(|e| {
        let msg = format!("設定の保存に失敗しました: {e}");
        error!(target: "commands::project", "cmd=write_settings err={msg}");
        msg
    })?;

    info!(target: "commands::project", "cmd=write_settings ok");
    Ok(())
}
