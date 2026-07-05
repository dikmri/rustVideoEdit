//! `probe_media` / `generate_thumbnail` / `list_system_fonts` / `check_ffmpeg`(DESIGN.md §5)。

use serde::Serialize;
use tauri::command;
use tracing::{error, info};

use crate::ffmpeg::probe::{self, MediaAsset};
use crate::ffmpeg::{locate, no_window};
use crate::paths;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFfmpegResult {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub version: Option<String>,
}

#[command]
pub fn check_ffmpeg() -> CheckFfmpegResult {
    info!(target: "commands::media", "cmd=check_ffmpeg");

    let ffmpeg = locate::locate_ffmpeg();
    let ffprobe = locate::locate_ffprobe();

    let version = ffmpeg
        .as_deref()
        .and_then(locate::run_version_command)
        .and_then(|out| out.lines().next().map(|s| s.to_string()));

    let result = CheckFfmpegResult {
        ffmpeg: ffmpeg.map(|p| p.to_string_lossy().to_string()),
        ffprobe: ffprobe.map(|p| p.to_string_lossy().to_string()),
        version,
    };

    info!(
        target: "commands::media",
        "cmd=check_ffmpeg ok ffmpeg={:?} ffprobe={:?} version={:?}",
        result.ffmpeg, result.ffprobe, result.version
    );

    result
}

#[command]
pub fn probe_media(path: String) -> Result<MediaAsset, String> {
    info!(target: "commands::media", "cmd=probe_media path={path}");
    match probe::probe_media(&path) {
        Ok(asset) => {
            info!(target: "commands::media", "cmd=probe_media ok");
            Ok(asset)
        }
        Err(e) => {
            error!(target: "commands::media", "cmd=probe_media err={e}");
            Err(e)
        }
    }
}

#[command]
pub fn generate_thumbnail(asset_id: String, path: String, time_sec: f64) -> Result<String, String> {
    info!(target: "commands::media", "cmd=generate_thumbnail asset_id={asset_id} path={path} time_sec={time_sec}");

    let out_path = paths::thumbs_dir().join(format!("{asset_id}.jpg"));
    if out_path.is_file() {
        info!(target: "commands::media", "cmd=generate_thumbnail ok (cached)");
        return Ok(out_path.to_string_lossy().to_string());
    }

    let ffmpeg = locate::locate_ffmpeg().ok_or_else(|| {
        let msg = "ffmpeg が見つかりません".to_string();
        error!(target: "commands::media", "cmd=generate_thumbnail err={msg}");
        msg
    })?;

    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.args([
        "-ss",
        &format!("{time_sec}"),
        "-i",
        &path,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "4",
        "-y",
    ]);
    cmd.arg(&out_path);
    no_window(&mut cmd);

    let output = cmd.output().map_err(|e| {
        let msg = format!("ffmpeg 実行に失敗しました: {e}");
        error!(target: "commands::media", "cmd=generate_thumbnail err={msg}");
        msg
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("サムネイル生成に失敗しました: {stderr}");
        error!(target: "commands::media", "cmd=generate_thumbnail err={msg}");
        return Err(msg);
    }

    info!(target: "commands::media", "cmd=generate_thumbnail ok");
    Ok(out_path.to_string_lossy().to_string())
}

#[command]
pub fn list_system_fonts() -> Vec<String> {
    info!(target: "commands::media", "cmd=list_system_fonts");
    match list_fonts_from_dir() {
        Ok(fonts) if !fonts.is_empty() => {
            info!(target: "commands::media", "cmd=list_system_fonts ok count={}", fonts.len());
            fonts
        }
        _ => {
            let fallback = vec![
                "Meiryo".to_string(),
                "Yu Gothic".to_string(),
                "Arial".to_string(),
            ];
            info!(target: "commands::media", "cmd=list_system_fonts fallback");
            fallback
        }
    }
}

fn list_fonts_from_dir() -> Result<Vec<String>, String> {
    let dir = std::path::PathBuf::from(r"C:\Windows\Fonts");
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut fonts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let ext_lower = ext.to_ascii_lowercase();
            if ext_lower == "ttf" || ext_lower == "ttc" || ext_lower == "otf" {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    fonts.push(stem.to_string());
                }
            }
        }
    }
    fonts.sort();
    Ok(fonts)
}
