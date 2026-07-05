//! `start_export` / `cancel_export` の実処理(DESIGN.md §8)。
//!
//! 単一の ffmpeg コマンドを構築し、`-progress pipe:1 -nostats -y` で進捗を取得しつつ
//! 子プロセスとして実行する。ジョブは `HashMap<String, Child>` を Mutex 越しに管理する。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use crate::commands::export::{ExportSpec, VideoCodec};
use crate::ffmpeg::probe::AssetKind;
use crate::ffmpeg::{filtergraph, locate, no_window};

static JOBS: OnceLock<Mutex<HashMap<String, std::process::Child>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, std::process::Child>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportProgressPayload {
    job_id: String,
    ratio: f64,
    out_time_sec: f64,
    speed: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportDonePayload {
    job_id: String,
    output_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportErrorPayload {
    job_id: String,
    message: String,
}

/// ffmpeg を起動して jobId を返す。実処理は別スレッドで進み、進捗/完了/エラーは
/// `export:progress` / `export:done` / `export:error` イベントで通知される。
pub fn start_export(app: AppHandle, spec: ExportSpec) -> Result<String, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    info!(target: "ffmpeg::encode", "cmd=start_export job_id={job_id} output={}", spec.output_path);

    let ffmpeg_path = locate::locate_ffmpeg().ok_or_else(|| {
        let msg = "ffmpeg が見つかりません".to_string();
        error!(target: "ffmpeg::encode", "job_id={job_id} err={msg}");
        msg
    })?;

    let filter_script_path = filtergraph::write_filter_script(&job_id, &spec)?;
    let args = build_ffmpeg_args(&spec, &filter_script_path);

    let cmdline_for_log = format!("\"{}\" {}", ffmpeg_path.display(), args.join(" "));
    info!(target: "ffmpeg::encode", "job_id={job_id} cmdline={cmdline_for_log}");

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("ffmpeg の起動に失敗しました: {e}");
        error!(target: "ffmpeg::encode", "job_id={job_id} err={msg}");
        msg
    })?;

    let stdout = child.stdout.take().expect("stdout should be piped");
    let stderr = child.stderr.take().expect("stderr should be piped");

    jobs().lock().unwrap().insert(job_id.clone(), child);

    let stderr_tail: Arc<Mutex<VecDeque<char>>> = Arc::new(Mutex::new(VecDeque::new()));

    // stderr は全行ログへ出しつつ、末尾 2000 文字をエラーメッセージ用に保持する。
    {
        let job_id = job_id.clone();
        let stderr_tail = stderr_tail.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                info!(target: "ffmpeg::stderr", "job_id={job_id} {line}");
                let mut tail = stderr_tail.lock().unwrap();
                for c in line.chars() {
                    tail.push_back(c);
                }
                tail.push_back('\n');
                while tail.len() > 2000 {
                    tail.pop_front();
                }
            }
        });
    }

    // stdout の -progress 出力を解析し、200ms 間隔で export:progress を emit する。
    {
        let job_id = job_id.clone();
        let app = app.clone();
        let duration_sec = spec.duration_sec.max(0.000_001);
        let output_path = spec.output_path.clone();
        let filter_script_path = filter_script_path.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut last_emit = Instant::now()
                .checked_sub(Duration::from_millis(200))
                .unwrap_or_else(Instant::now);
            let mut out_time_sec = 0.0f64;
            let mut speed = 0.0f64;

            for line in reader.lines().map_while(Result::ok) {
                if let Some(v) = line.strip_prefix("out_time_ms=") {
                    if let Ok(us) = v.trim().parse::<i64>() {
                        out_time_sec = (us as f64) / 1_000_000.0;
                    }
                } else if let Some(v) = line.strip_prefix("out_time=") {
                    if let Some(sec) = parse_ffmpeg_timestamp(v.trim()) {
                        out_time_sec = sec;
                    }
                } else if let Some(v) = line.strip_prefix("speed=") {
                    let cleaned = v.trim().trim_end_matches('x');
                    if let Ok(s) = cleaned.parse::<f64>() {
                        speed = s;
                    }
                } else if line.starts_with("progress=")
                    && last_emit.elapsed() >= Duration::from_millis(200)
                {
                    let ratio = (out_time_sec / duration_sec).clamp(0.0, 1.0);
                    let _ = app.emit(
                        "export:progress",
                        ExportProgressPayload {
                            job_id: job_id.clone(),
                            ratio,
                            out_time_sec,
                            speed,
                        },
                    );
                    last_emit = Instant::now();
                }
            }

            let removed = jobs().lock().unwrap().remove(&job_id);
            match removed {
                Some(mut child) => match child.wait() {
                    Ok(status) if status.success() => {
                        info!(target: "ffmpeg::encode", "job_id={job_id} ok");
                        let _ = app.emit(
                            "export:done",
                            ExportDonePayload {
                                job_id: job_id.clone(),
                                output_path,
                            },
                        );
                    }
                    Ok(status) => {
                        let code = status.code().unwrap_or(-1);
                        let tail: String = stderr_tail.lock().unwrap().iter().collect();
                        let msg = format!("ffmpeg が終了コード {code} で終了しました: {tail}");
                        error!(target: "ffmpeg::encode", "job_id={job_id} err={msg}");
                        let _ = app.emit(
                            "export:error",
                            ExportErrorPayload {
                                job_id: job_id.clone(),
                                message: msg,
                            },
                        );
                    }
                    Err(e) => {
                        let msg = format!("ffmpeg の終了待機に失敗しました: {e}");
                        error!(target: "ffmpeg::encode", "job_id={job_id} err={msg}");
                        let _ = app.emit(
                            "export:error",
                            ExportErrorPayload {
                                job_id: job_id.clone(),
                                message: msg,
                            },
                        );
                    }
                },
                None => {
                    info!(target: "ffmpeg::encode", "job_id={job_id} cancelled (job already removed)");
                }
            }

            let _ = std::fs::remove_file(&filter_script_path);
        });
    }

    Ok(job_id)
}

/// ジョブを kill する。既に終了/キャンセル済みの場合もエラーにはしない。
pub fn cancel_export(job_id: &str) -> Result<(), String> {
    let mut guard = jobs().lock().unwrap();
    if let Some(mut child) = guard.remove(job_id) {
        drop(guard);
        child
            .kill()
            .map_err(|e| format!("プロセス停止に失敗しました: {e}"))?;
        let _ = child.wait();
        info!(target: "ffmpeg::encode", "job_id={job_id} cancelled");
        Ok(())
    } else {
        warn!(target: "ffmpeg::encode", "job_id={job_id} cancel対象が見つかりません(既に終了)");
        Ok(())
    }
}

fn parse_ffmpeg_timestamp(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: f64 = parts[0].parse().ok()?;
    let minutes: f64 = parts[1].parse().ok()?;
    let seconds: f64 = parts[2].parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn build_ffmpeg_args(spec: &ExportSpec, filter_script_path: &Path) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // 画像入力(-loop 1)に必要な最大秒数を事前計算する。
    let mut image_needed: HashMap<usize, f64> = HashMap::new();
    for vc in &spec.video_clips {
        if vc.is_image {
            if let Some(idx) = vc.input_index {
                let entry = image_needed.entry(idx).or_insert(0.0);
                if vc.duration > *entry {
                    *entry = vc.duration;
                }
            }
        }
    }

    let mut sorted_inputs = spec.inputs.clone();
    sorted_inputs.sort_by_key(|i| i.index);

    for input in &sorted_inputs {
        if input.kind == AssetKind::Image {
            let needed = image_needed
                .get(&input.index)
                .copied()
                .unwrap_or(spec.duration_sec.max(1.0));
            args.push("-loop".into());
            args.push("1".into());
            args.push("-t".into());
            args.push(format!("{needed:.6}"));
            args.push("-i".into());
            args.push(input.path.clone());
        } else {
            args.push("-i".into());
            args.push(input.path.clone());
        }
    }

    args.push("-filter_complex_script".into());
    args.push(filter_script_path.to_string_lossy().to_string());

    let video_map_label = if spec.video_clips.is_empty() {
        "base".to_string()
    } else {
        format!("m{}", spec.video_clips.len() - 1)
    };

    args.push("-map".into());
    args.push(format!("[{video_map_label}]"));
    args.push("-map".into());
    args.push("[aout]".into());

    args.push("-t".into());
    args.push(format!("{:.6}", spec.duration_sec));
    args.push("-r".into());
    args.push(format!("{:.6}", spec.fps));

    match spec.video_codec {
        VideoCodec::H264 => {
            args.extend(["-c:v", "libx264", "-preset", "medium", "-crf"].map(String::from));
            args.push(format!("{}", spec.quality));
            args.extend(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a"].map(String::from));
            args.push(format!("{}k", spec.audio_bitrate_kbps));
        }
        VideoCodec::Hevc => {
            args.extend(["-c:v", "libx265", "-preset", "medium", "-crf"].map(String::from));
            args.push(format!("{}", spec.quality));
            args.extend(
                [
                    "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a",
                ]
                .map(String::from),
            );
            args.push(format!("{}k", spec.audio_bitrate_kbps));
        }
        VideoCodec::Prores => {
            args.extend(
                [
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "3",
                    "-pix_fmt",
                    "yuv422p10le",
                    "-c:a",
                    "pcm_s16le",
                ]
                .map(String::from),
            );
        }
    }

    args.extend(["-progress", "pipe:1", "-nostats", "-y"].map(String::from));
    args.push(spec.output_path.clone());

    args
}
