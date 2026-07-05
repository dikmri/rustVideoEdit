//! ffmpeg / ffprobe の実行ファイル探索(DESIGN.md §5)。
//!
//! 探索順: PATH → 実行ファイルの隣の `bin/` → `runtime/bin/`。
//! 見つけた結果は `OnceLock` でキャッシュする。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::ffmpeg::no_window;
use crate::paths;

#[cfg(windows)]
const EXE_SUFFIX: &str = ".exe";
#[cfg(not(windows))]
const EXE_SUFFIX: &str = "";

static FFMPEG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static FFPROBE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// ffmpeg 実行ファイルのパスを探索・キャッシュして返す。
pub fn locate_ffmpeg() -> Option<PathBuf> {
    FFMPEG_PATH.get_or_init(|| find_tool("ffmpeg")).clone()
}

/// ffprobe 実行ファイルのパスを探索・キャッシュして返す。
pub fn locate_ffprobe() -> Option<PathBuf> {
    FFPROBE_PATH.get_or_init(|| find_tool("ffprobe")).clone()
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let exe_name = format!("{name}{EXE_SUFFIX}");

    // 1. PATH 環境変数を走査
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(&exe_name);
            if verify_tool(&candidate) {
                return Some(candidate);
            }
        }
    }

    // 2. 実行ファイルの隣の bin/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidate = exe_dir.join("bin").join(&exe_name);
            if verify_tool(&candidate) {
                return Some(candidate);
            }
        }
    }

    // 3. runtime/bin/
    let candidate = paths::runtime_dir().join("bin").join(&exe_name);
    if verify_tool(&candidate) {
        return Some(candidate);
    }

    None
}

fn verify_tool(path: &Path) -> bool {
    path.is_file() && run_version_command(path).is_some()
}

/// 指定した実行ファイルを `-version` 付きで実行し、成功したら stdout を返す。
pub fn run_version_command(path: &Path) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("-version");
    no_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}
