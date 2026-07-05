//! Tauri Builder の組み立て(DESIGN.md §2)。main.rs はこの `run()` を呼ぶだけ。

mod commands;
mod ffmpeg;
mod logsys;
mod paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (log_guard, log_path) = logsys::init();
    tracing::info!(target: "app", "起動: ログファイル = {}", log_path.display());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(log_guard)
        .setup(|_app| {
            tracing::info!(target: "app", "setup 完了");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::media::check_ffmpeg,
            commands::media::probe_media,
            commands::media::generate_thumbnail,
            commands::media::list_system_fonts,
            commands::project::save_project,
            commands::project::load_project,
            commands::project::read_settings,
            commands::project::write_settings,
            logsys::log_event,
            commands::export::start_export,
            commands::export::cancel_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
