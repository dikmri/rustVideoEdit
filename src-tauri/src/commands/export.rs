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

fn default_shadow_offset() -> f64 {
    2.0
}

/// `src/types/model.ts` の `TextStyle` に対応(DESIGN.md §14.2 で拡張)。
/// 縁取り/影/行間は後方互換のため全フィールドに `#[serde(default)]` を付与する。
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
    /// 縁取り色(既定 null = 縁取りなし)。
    #[serde(default)]
    pub outline_color: Option<String>,
    /// 縁取り太さ(0..20 ソース px、既定 0)。
    #[serde(default)]
    pub outline_width: f64,
    /// 影色(既定 null = 影なし)。
    #[serde(default)]
    pub shadow_color: Option<String>,
    /// 影オフセット X(-50..50、既定 2)。
    #[serde(default = "default_shadow_offset")]
    pub shadow_x: f64,
    /// 影オフセット Y(-50..50、既定 2)。
    #[serde(default = "default_shadow_offset")]
    pub shadow_y: f64,
    /// 行間(0..100 px、既定 0)。
    #[serde(default)]
    pub line_spacing: f64,
}

fn default_true() -> bool {
    true
}

fn default_block_size() -> f64 {
    16.0
}

/// `src/types/model.ts` の `MosaicKeyframe` に対応(DESIGN.md §13.2)。
/// 後方互換のため全フィールドに `#[serde(default)]` を付与する。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MosaicKeyframe {
    /// クリップローカル秒(出力時間基準、0..duration)。
    #[serde(default)]
    pub time: f64,
    /// 中心 X(ソースピクセル座標、変形前)。
    #[serde(default)]
    pub cx: f64,
    /// 中心 Y(ソースピクセル座標、変形前)。
    #[serde(default)]
    pub cy: f64,
    /// 幅(ソースピクセル)。
    #[serde(default)]
    pub w: f64,
    /// 高さ(ソースピクセル)。
    #[serde(default)]
    pub h: f64,
    /// 回転(度)。
    #[serde(default)]
    pub rotation: f64,
    /// 表示フラグ(ステップ補間)。
    #[serde(default = "default_true")]
    pub visible: bool,
}

/// `src/types/model.ts` の `MosaicRegion` に対応(DESIGN.md §13.2)。
/// 後方互換のため全フィールドに `#[serde(default)]` を付与する。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MosaicRegion {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// モザイク粒度(ソース px、4..80、既定 16)。
    #[serde(default = "default_block_size")]
    pub block_size: f64,
    /// time 昇順、常に 1 個以上(空の場合はスキップされる)。
    #[serde(default)]
    pub keyframes: Vec<MosaicKeyframe>,
}

/// `src/types/model.ts` の `TransitionType` に対応(DESIGN.md §14.1)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionType {
    Dissolve,
    Wipeleft,
    Wiperight,
    Wipeup,
    Wipedown,
    Slideleft,
    Slideright,
}

/// `Clip.transitionIn` に対応(DESIGN.md §14.1)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionIn {
    #[serde(rename = "type")]
    pub kind: TransitionType,
    pub duration: f64,
}

/// DESIGN.md §5 の `VClip`(§14.1 でトランジション関連フィールドを追加)。
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
    /// モザイク領域(DESIGN.md §13.2)。旧フロントからの spec には無いため default。
    #[serde(default)]
    pub mosaics: Vec<MosaicRegion>,
    /// このクリップの先頭で行うトランジション(DESIGN.md §14.1)。旧 spec には無いため default。
    #[serde(default)]
    pub transition_in: Option<TransitionIn>,
    /// このクリップ自身を末尾に延長する出力秒数(次の隣接クリップの transitionIn 用)。
    #[serde(default)]
    pub extend_tail: f64,
    /// out 点より先に残っているソース素材の出力秒数(画像・テキストは 1e9)。
    #[serde(default)]
    pub source_tail_avail: f64,
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
