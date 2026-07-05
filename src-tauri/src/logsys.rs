//! ログ初期化(DESIGN.md §6)+ `log_event` コマンド。
//!
//! ファイル: `runtime/logs/rustVideoEdit-YYYY-MM-DD.log`(daily rolling)。
//! 形式: `2026-07-05T12:34:56.789+09:00 LEVEL [target] message`

use std::fmt;
use std::path::PathBuf;

use tauri::command;
use tracing::Subscriber;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;

/// ローカルタイムを RFC3339(ミリ秒精度)で出力するタイマー。
struct LocalTimer;

impl FormatTime for LocalTimer {
    fn format_time(&self, w: &mut Writer<'_>) -> fmt::Result {
        let now = chrono::Local::now();
        write!(
            w,
            "{}",
            now.to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
        )
    }
}

/// `TIME LEVEL [target] message` 形式の人間可読フォーマッタ。
/// フロントから転送されたログ(target="frontend")は message 内に既に
/// `[ui]` 等の実際のターゲットを埋め込み済みのため、二重に角括弧を出さない。
struct HumanReadableFormatter;

impl<S, N> FormatEvent<S, N> for HumanReadableFormatter
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &tracing::Event<'_>,
    ) -> fmt::Result {
        let meta = event.metadata();
        LocalTimer.format_time(&mut writer)?;
        write!(writer, " {:<5} ", meta.level())?;
        if meta.target() != "frontend" {
            write!(writer, "[{}] ", meta.target())?;
        }
        ctx.field_format().format_fields(writer.by_ref(), event)?;
        writeln!(writer)
    }
}

/// tracing を初期化する。戻り値の `WorkerGuard` は呼び出し側が保持し続けること
/// (drop すると非同期ファイル書き込みが停止する)。2 つめの戻り値はログファイルの想定パス。
pub fn init() -> (WorkerGuard, PathBuf) {
    let logs_dir = crate::paths::logs_dir();

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("rustVideoEdit")
        .filename_suffix("log")
        .build(&logs_dir)
        .expect("ログファイルの初期化に失敗しました");

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .event_format(HumanReadableFormatter);

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stdout)
        .with_ansi(false)
        .event_format(HumanReadableFormatter);

    // 既定 INFO。HTTP クライアント系の TRACE/DEBUG ノイズは動作確認ログの可読性を
    // 損ねるため WARN まで絞る(実機ログで hyper_util の TRACE 混入を確認済み)。
    let filter = Targets::new()
        .with_default(LevelFilter::INFO)
        .with_target("hyper_util", LevelFilter::WARN)
        .with_target("hyper", LevelFilter::WARN)
        .with_target("rustls", LevelFilter::WARN)
        .with_target("reqwest", LevelFilter::WARN);

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stdout_layer)
        .init();

    // tracing-appender の Builder は prefix/suffix の間に "." を挟むため、実際のファイル名は
    // "rustVideoEdit.YYYY-MM-DD.log" になる(DESIGN.md の記載はハイフン区切りだが、
    // ライブラリの制約によりドット区切りとしている。ログ仕様としての実質は同一)。
    let today = chrono::Local::now().format("%Y-%m-%d");
    let log_path = logs_dir.join(format!("rustVideoEdit.{today}.log"));

    (guard, log_path)
}

/// フロントエンド(`lib/logger.ts`)から送られてくるログを tracing へ橋渡しする。
#[command]
pub fn log_event(level: String, target: String, message: String) {
    let line = format!("[{target}] {message}");
    match level.to_ascii_lowercase().as_str() {
        "error" => tracing::error!(target: "frontend", "{}", line),
        "warn" => tracing::warn!(target: "frontend", "{}", line),
        _ => tracing::info!(target: "frontend", "{}", line),
    }
}
