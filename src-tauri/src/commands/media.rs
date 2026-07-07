//! `probe_media` / `generate_thumbnail` / `list_system_fonts` / `check_ffmpeg` /
//! `generate_waveform`(DESIGN.md §5, §14.3)。

use serde::{Deserialize, Serialize};
use tauri::command;
use tracing::{error, info};

use crate::ffmpeg::probe::{self, MediaAsset};
use crate::ffmpeg::{locate, no_window};
use crate::paths;

/// 波形 1 本あたりのバケット数(DESIGN.md §14.3)。
const WAVEFORM_BUCKETS: usize = 2000;

/// `runtime/cache/waves/{assetId}.json` の内容(DESIGN.md §14.3)。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaveformJson {
    version: u32,
    duration_sec: f64,
    peaks: Vec<u8>,
}

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

/// 音声波形 JSON を生成する(DESIGN.md §14.3)。
///
/// `ffmpeg -map a:0 -ac 1 -ar 8000 -f s16le -` で 8000Hz モノラル PCM を stdout へ吐かせ、
/// 全サンプルを 2000 バケットに集約(各バケットの max|s| を 0..100 の u8 に正規化)する。
/// `runtime/cache/waves/{assetId}.json` へ保存し、既存ファイルがあればスキップする。
/// 音声ストリームが無い場合はエラーにせず `peaks: []` の JSON を返す。
#[command]
pub fn generate_waveform(asset_id: String, path: String) -> Result<String, String> {
    info!(target: "commands::media", "cmd=generate_waveform asset_id={asset_id} path={path}");

    let out_path = paths::waves_dir().join(format!("{asset_id}.json"));
    if out_path.is_file() {
        info!(target: "commands::media", "cmd=generate_waveform ok (cached) asset_id={asset_id}");
        return Ok(out_path.to_string_lossy().to_string());
    }

    let asset = probe::probe_media(&path).map_err(|e| {
        let msg = format!("probe_media に失敗しました: {e}");
        error!(target: "commands::media", "cmd=generate_waveform err={msg}");
        msg
    })?;

    if !asset.has_audio {
        let json = WaveformJson {
            version: 1,
            duration_sec: asset.duration,
            peaks: Vec::new(),
        };
        write_waveform_json(&out_path, &json)?;
        info!(target: "commands::media", "cmd=generate_waveform ok (no audio) asset_id={asset_id}");
        return Ok(out_path.to_string_lossy().to_string());
    }

    let ffmpeg = locate::locate_ffmpeg().ok_or_else(|| {
        let msg = "ffmpeg が見つかりません".to_string();
        error!(target: "commands::media", "cmd=generate_waveform err={msg}");
        msg
    })?;

    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.args([
        "-v", "error", "-i", &path, "-map", "a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "-",
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    no_window(&mut cmd);

    let output = cmd.output().map_err(|e| {
        let msg = format!("ffmpeg 実行に失敗しました: {e}");
        error!(target: "commands::media", "cmd=generate_waveform err={msg}");
        msg
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("波形生成に失敗しました: {stderr}");
        error!(target: "commands::media", "cmd=generate_waveform err={msg}");
        return Err(msg);
    }

    let peaks = compute_peaks(&output.stdout, WAVEFORM_BUCKETS);

    let json = WaveformJson {
        version: 1,
        duration_sec: asset.duration,
        peaks,
    };
    write_waveform_json(&out_path, &json)?;

    info!(
        target: "commands::media",
        "cmd=generate_waveform ok asset_id={asset_id} buckets={WAVEFORM_BUCKETS}"
    );
    Ok(out_path.to_string_lossy().to_string())
}

fn write_waveform_json(out_path: &std::path::Path, json: &WaveformJson) -> Result<(), String> {
    let text = serde_json::to_string(json)
        .map_err(|e| format!("波形 JSON の直列化に失敗しました: {e}"))?;
    std::fs::write(out_path, text).map_err(|e| format!("波形 JSON の書き込みに失敗しました: {e}"))
}

/// s16le モノラル PCM バイト列を `buckets` 個の区間に均等分割し、各区間の |sample| 最大値を
/// 0..100 の u8 へ正規化する(DESIGN.md §14.3)。サンプル数によらず常に `buckets` 個返す。
fn compute_peaks(pcm: &[u8], buckets: usize) -> Vec<u8> {
    let sample_count = pcm.len() / 2;
    let sample_at = |i: usize| -> i16 {
        let o = i * 2;
        i16::from_le_bytes([pcm[o], pcm[o + 1]])
    };

    let mut peaks = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let start = sample_count * b / buckets;
        if start >= sample_count {
            peaks.push(0);
            continue;
        }
        let end = (sample_count * (b + 1) / buckets)
            .max(start + 1)
            .min(sample_count);

        let mut max_abs: i32 = 0;
        for i in start..end {
            let v = sample_at(i).unsigned_abs() as i32;
            if v > max_abs {
                max_abs = v;
            }
        }
        let normalized = ((max_abs as f64 / 32768.0) * 100.0)
            .round()
            .clamp(0.0, 100.0) as u8;
        peaks.push(normalized);
    }
    peaks
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sine_pcm_s16le(samples: usize, amplitude: i16) -> Vec<u8> {
        let mut out = Vec::with_capacity(samples * 2);
        for i in 0..samples {
            let phase = (i as f64) * 0.1;
            let v = (phase.sin() * amplitude as f64).round() as i16;
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    #[test]
    fn compute_peaks_always_returns_exact_bucket_count() {
        // サンプル数がバケット数よりずっと多い場合。
        let pcm = sine_pcm_s16le(200_000, 30000);
        assert_eq!(
            compute_peaks(&pcm, WAVEFORM_BUCKETS).len(),
            WAVEFORM_BUCKETS
        );

        // サンプル数がバケット数よりずっと少ない場合でも常に buckets 個返す。
        let pcm_small = sine_pcm_s16le(10, 30000);
        assert_eq!(
            compute_peaks(&pcm_small, WAVEFORM_BUCKETS).len(),
            WAVEFORM_BUCKETS
        );

        // サンプルが 1 つも無い場合(空バイト列)。
        assert_eq!(compute_peaks(&[], WAVEFORM_BUCKETS).len(), WAVEFORM_BUCKETS);
    }

    #[test]
    fn compute_peaks_silence_is_all_zero() {
        let pcm = vec![0u8; 4000 * 2];
        let peaks = compute_peaks(&pcm, WAVEFORM_BUCKETS);
        assert!(peaks.iter().all(|&p| p == 0));
    }

    #[test]
    fn compute_peaks_full_scale_normalizes_near_100() {
        // i16::MAX 定振幅 → |s|/32768*100 は 100 弱(丸め結果は 100 になる)。
        let pcm = sine_pcm_s16le(4000, i16::MAX);
        let peaks = compute_peaks(&pcm, WAVEFORM_BUCKETS);
        assert!(peaks.iter().any(|&p| p >= 90));
        assert!(peaks.iter().all(|&p| p <= 100));
    }

    /// 実機スモークテスト用: `RVE_WAVEFORM_TEST_VIDEO` にテスト動画の絶対パスを設定して実行する。
    /// `cargo test -- --ignored waveform_smoke_test_generates_2000_nonzero_peaks`。
    /// 環境変数が無ければ何もせず終了する(ffmpeg が無い/CI 環境でのスキップ用)。
    #[test]
    #[ignore = "手動スモークテスト用(RVE_WAVEFORM_TEST_VIDEO へ動画パスを設定して実行)"]
    fn waveform_smoke_test_generates_2000_nonzero_peaks() {
        let path = match std::env::var("RVE_WAVEFORM_TEST_VIDEO") {
            Ok(p) => p,
            Err(_) => return,
        };
        let asset_id = format!("test-waveform-{}", uuid::Uuid::new_v4());
        let out = generate_waveform(asset_id, path).expect("generate_waveform に失敗");
        let text = std::fs::read_to_string(&out).expect("波形 JSON の読み込みに失敗");
        let json: WaveformJson = serde_json::from_str(&text).expect("波形 JSON の解析に失敗");
        assert_eq!(json.peaks.len(), WAVEFORM_BUCKETS);
        assert!(
            json.peaks.iter().any(|&p| p > 0),
            "非ゼロのピークを含むこと"
        );
        assert!(json.duration_sec > 0.0);
    }
}
