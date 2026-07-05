//! `start_export` / `cancel_export` コマンドと `ExportSpec` 関連の型(DESIGN.md §5, §8)。

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle};
use tracing::{error, info};

use crate::ffmpeg::encode;
use crate::ffmpeg::probe::AssetKind;

/// `src/types/model.ts` の `ClipTransform` に対応。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
}

/// `src/types/model.ts` の `Effect` に対応。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Effect {
    Eq {
        brightness: f64,
        contrast: f64,
        saturation: f64,
    },
    Blur {
        radius: f64,
    },
}

/// `src/types/model.ts` の `TextStyle.align` に対応。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

/// `src/types/model.ts` の `TextStyle` に対応。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub content: String,
    pub font_family: String,
    pub font_size: f64,
    pub color: String,
    pub bold: bool,
    pub align: TextAlign,
    pub background: Option<String>,
}

/// DESIGN.md §5 の `VClip`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VClip {
    pub input_index: Option<usize>,
    pub start: f64,
    pub duration: f64,
    pub in_point: f64,
    pub speed: f64,
    pub opacity: f64,
    pub transform: ClipTransform,
    pub fade_in: f64,
    pub fade_out: f64,
    pub effects: Vec<Effect>,
    pub text: Option<TextStyle>,
    pub asset_w: Option<f64>,
    pub asset_h: Option<f64>,
    pub is_image: bool,
}

/// DESIGN.md §5 の `AClip`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AClip {
    pub input_index: usize,
    pub start: f64,
    pub duration: f64,
    pub in_point: f64,
    pub speed: f64,
    pub volume: f64,
    pub fade_in: f64,
    pub fade_out: f64,
}

/// DESIGN.md §5 の `ExportSpec.inputs` 要素。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInput {
    pub index: usize,
    pub path: String,
    pub kind: AssetKind,
}

/// `src/types/model.ts` の `ExportSpec.videoCodec` に対応。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    Hevc,
    Prores,
}

/// DESIGN.md §5 の `ExportSpec`。フロント `lib/exportSpec.ts` が生成する。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub output_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub sample_rate: u32,
    pub duration_sec: f64,
    pub video_codec: VideoCodec,
    pub quality: f64,
    pub audio_bitrate_kbps: u32,
    pub inputs: Vec<ExportInput>,
    pub video_clips: Vec<VClip>,
    pub audio_clips: Vec<AClip>,
}

#[command]
pub fn start_export(app: AppHandle, spec: ExportSpec) -> Result<String, String> {
    info!(target: "commands::export", "cmd=start_export output={} clips(v={},a={})", spec.output_path, spec.video_clips.len(), spec.audio_clips.len());
    match encode::start_export(app, spec) {
        Ok(job_id) => {
            info!(target: "commands::export", "cmd=start_export ok job_id={job_id}");
            Ok(job_id)
        }
        Err(e) => {
            error!(target: "commands::export", "cmd=start_export err={e}");
            Err(e)
        }
    }
}

#[command]
pub fn cancel_export(job_id: String) -> Result<(), String> {
    info!(target: "commands::export", "cmd=cancel_export job_id={job_id}");
    match encode::cancel_export(&job_id) {
        Ok(()) => {
            info!(target: "commands::export", "cmd=cancel_export ok");
            Ok(())
        }
        Err(e) => {
            error!(target: "commands::export", "cmd=cancel_export err={e}");
            Err(e)
        }
    }
}
