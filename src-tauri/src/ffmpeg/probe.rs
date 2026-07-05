//! `probe_media` の実装(DESIGN.md §5)。
//! `ffprobe -v error -show_format -show_streams -of json` を実行して `MediaAsset` を構築する。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::{error, info};

use crate::ffmpeg::{locate, no_window};

/// `src/types/model.ts` の `AssetKind` に対応。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
}

/// `src/types/model.ts` の `MediaAsset` に対応(camelCase で JSON 化)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: AssetKind,
    pub duration: f64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub codec: Option<String>,
    pub thumbnail: Option<String>,
    /// format.bit_rate(bps 文字列)を kbps に変換した値。取得できない場合は None(§13.5)。
    pub bitrate_kbps: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    format: FfprobeFormat,
    #[serde(default)]
    streams: Vec<FfprobeStream>,
}

#[derive(Debug, Default, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    bit_rate: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FfprobeDisposition {
    #[serde(default)]
    attached_pic: i64,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    r_frame_rate: Option<String>,
    #[serde(default)]
    disposition: FfprobeDisposition,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];

/// `path` のメディアファイルを ffprobe で解析し `MediaAsset` を構築する。
pub fn probe_media(path: &str) -> Result<MediaAsset, String> {
    info!(target: "ffmpeg::probe", "cmd=probe_media path={path}");

    let ffprobe = locate::locate_ffprobe().ok_or_else(|| {
        let msg = "ffprobe が見つかりません".to_string();
        error!(target: "ffmpeg::probe", "err={msg}");
        msg
    })?;

    let mut cmd = std::process::Command::new(&ffprobe);
    cmd.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        path,
    ]);
    no_window(&mut cmd);

    let output = cmd.output().map_err(|e| {
        let msg = format!("ffprobe 実行に失敗しました: {e}");
        error!(target: "ffmpeg::probe", "err={msg}");
        msg
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("ffprobe がエラー終了しました: {stderr}");
        error!(target: "ffmpeg::probe", "err={msg}");
        return Err(msg);
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout).map_err(|e| {
        let msg = format!("ffprobe の出力解析に失敗しました: {e}");
        error!(target: "ffmpeg::probe", "err={msg}");
        msg
    })?;

    let ext_is_image = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false);

    let video_stream = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0);

    let audio_stream = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));

    let has_audio = audio_stream.is_some();

    // 拡張子が画像系の場合は常に image 扱い(標準的な静止画は video ストリームとして
    // 検出されてしまうため、拡張子判定を優先する)。それ以外は video ストリームの有無 →
    // 音声のみか、の順で判定する。
    let kind = if ext_is_image {
        AssetKind::Image
    } else if video_stream.is_some() {
        AssetKind::Video
    } else if has_audio {
        AssetKind::Audio
    } else {
        AssetKind::Video
    };

    let duration = if kind == AssetKind::Image {
        0.0
    } else {
        parsed
            .format
            .duration
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
    };

    let dimension_stream = video_stream.or_else(|| {
        if kind == AssetKind::Image {
            parsed
                .streams
                .iter()
                .find(|s| s.codec_type.as_deref() == Some("video"))
        } else {
            None
        }
    });

    let width = dimension_stream.and_then(|s| s.width);
    let height = dimension_stream.and_then(|s| s.height);
    let fps = dimension_stream
        .and_then(|s| s.r_frame_rate.as_deref())
        .and_then(parse_frame_rate);

    let bitrate_kbps = parsed
        .format
        .bit_rate
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|bps| bps / 1000.0);

    let codec = match kind {
        AssetKind::Video => video_stream.and_then(|s| s.codec_name.clone()),
        AssetKind::Audio => audio_stream.and_then(|s| s.codec_name.clone()),
        AssetKind::Image => dimension_stream.and_then(|s| s.codec_name.clone()),
    };

    let name = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();

    let abs_path = std::fs::canonicalize(path)
        .map(|p| normalize_windows_path(&p))
        .unwrap_or_else(|_| path.to_string());

    let asset = MediaAsset {
        id: uuid::Uuid::new_v4().to_string(),
        path: abs_path,
        name,
        kind,
        duration,
        width,
        height,
        fps,
        has_audio,
        codec,
        thumbnail: None,
        bitrate_kbps,
    };

    info!(
        target: "ffmpeg::probe",
        "cmd=probe_media ok kind={:?} duration={} width={:?} height={:?}",
        asset.kind, asset.duration, asset.width, asset.height
    );

    Ok(asset)
}

fn parse_frame_rate(raw: &str) -> Option<f64> {
    let mut parts = raw.split('/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den_str = parts.next().unwrap_or("1");
    let den: f64 = den_str.parse().ok()?;
    if den == 0.0 {
        None
    } else {
        Some(num / den)
    }
}

/// `\\?\C:\foo\bar` のような Windows の拡張長パスプレフィックスを取り除く。
fn normalize_windows_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(|s| s.to_string()).unwrap_or(s)
}
