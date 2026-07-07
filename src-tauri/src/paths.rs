//! 実行時パス規約(DESIGN.md §3)。
//!
//! アプリが書き出すファイル(ログ・サムネイルキャッシュ・設定)は OS 共通領域を使わず、
//! `runtime_dir()` 配下に置く。
//! - デバッグビルド: `CARGO_MANIFEST_DIR` の親(=リポジトリ root)/runtime
//! - リリースビルド: 実行ファイルと同じディレクトリの runtime
//!   (作成失敗時のみ `dirs::data_local_dir()/SOBAVideoEditor` にフォールバック)

use std::path::PathBuf;
use std::sync::OnceLock;

static RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();

/// runtime ディレクトリを解決する(存在しなければ作成する)。
pub fn runtime_dir() -> PathBuf {
    RUNTIME_DIR.get_or_init(resolve_runtime_dir).clone()
}

fn resolve_runtime_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = <repo>/src-tauri なので親がリポジトリ root。
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .map(PathBuf::from)
            .unwrap_or(manifest_dir);
        let dir = repo_root.join("runtime");
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
        dir
    } else {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from));
        if let Some(exe_dir) = exe_dir {
            let dir = exe_dir.join("runtime");
            if std::fs::create_dir_all(&dir).is_ok() {
                return dir;
            }
        }
        // フォールバック: OS 共通領域(作成失敗時のみ)。
        let fallback = dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("SOBAVideoEditor");
        let _ = std::fs::create_dir_all(&fallback);
        fallback
    }
}

/// runtime/logs
pub fn logs_dir() -> PathBuf {
    let dir = runtime_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// runtime/cache
pub fn cache_dir() -> PathBuf {
    let dir = runtime_dir().join("cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// runtime/cache/thumbs
pub fn thumbs_dir() -> PathBuf {
    let dir = cache_dir().join("thumbs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// runtime/cache/waves(音声波形 JSON キャッシュ、DESIGN.md §14.3)
pub fn waves_dir() -> PathBuf {
    let dir = cache_dir().join("waves");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// runtime/settings.json
pub fn settings_path() -> PathBuf {
    runtime_dir().join("settings.json")
}
