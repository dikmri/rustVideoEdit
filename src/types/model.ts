// データモデル(DESIGN.md §4)。唯一の型定義箇所。
// 時間は全て秒(number)。ID は UUID v4 文字列。

export type AssetKind = "video" | "audio" | "image";

export interface MediaAsset {
  id: string;
  path: string; // 絶対パス
  name: string; // ファイル名
  kind: AssetKind;
  duration: number; // 画像は 0
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  codec: string | null;
  thumbnail: string | null; // キャッシュ画像の絶対パス
}

export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}
// x,y: プロジェクト解像度基準の中心からのオフセット(px)。scale: 1=原寸。rotation: 度。

export type Effect =
  | { type: "eq"; brightness: number; contrast: number; saturation: number } // b:-1..1(0), c:0..2(1), s:0..3(1)
  | { type: "blur"; radius: number }; // 0..50(0)

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number; // px(プロジェクト解像度基準)
  color: string; // #RRGGBB
  bold: boolean;
  align: "left" | "center" | "right";
  background: string | null; // #RRGGBB or null
}

export interface Clip {
  id: string;
  assetId: string | null; // null = テキストクリップ(video トラックのみ)
  start: number; // タイムライン上の開始秒
  duration: number; // タイムライン上の長さ(速度適用後)
  inPoint: number; // ソース内 in 秒(source out = inPoint + duration*speed)
  speed: number; // 0.25..4、画像/テキストは常に 1
  volume: number; // 0..2
  muted: boolean;
  opacity: number; // 0..1
  transform: ClipTransform;
  fadeIn: number; // 秒。video=不透明度+音量、audio=音量
  fadeOut: number;
  effects: Effect[];
  text: TextStyle | null; // テキストクリップのみ非 null
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  name: string; // "V1","A1" 等
  locked: boolean;
  muted: boolean;
  clips: Clip[]; // start 昇順を維持。同一トラック内で重なり禁止
}

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
}

export interface Project {
  version: 1;
  name: string;
  settings: ProjectSettings; // 既定 1920x1080 / 30fps / 48000
  assets: MediaAsset[];
  videoTracks: Track[]; // index 0 = V1 = 最下層。UI では逆順表示(上ほど上層)
  audioTracks: Track[]; // index 0 = A1。UI では video の下に A1, A2…
}

// 書き出し仕様(DESIGN.md §5, §8)。lib/exportSpec.ts が Project から生成する。

export type VideoCodec = "h264" | "hevc" | "prores";

export interface VClip {
  inputIndex: number | null; // null=テキスト
  start: number;
  duration: number;
  inPoint: number;
  speed: number;
  opacity: number;
  transform: ClipTransform;
  fadeIn: number;
  fadeOut: number;
  effects: Effect[];
  text: TextStyle | null;
  assetW: number | null;
  assetH: number | null;
  isImage: boolean;
}

export interface AClip {
  inputIndex: number;
  start: number;
  duration: number;
  inPoint: number;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

export interface ExportInput {
  index: number;
  path: string;
  kind: AssetKind;
}

export interface ExportSpec {
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  durationSec: number; // タイムライン全長
  videoCodec: VideoCodec;
  quality: number; // h264/hevc: CRF 値
  audioBitrateKbps: number; // aac 用(prores は pcm_s16le)
  inputs: ExportInput[]; // index は ffmpeg -i の順
  videoClips: VClip[]; // 下層トラックから順(V1 の全クリップ→V2…)、各トラック内 start 昇順
  audioClips: AClip[]; // audio トラックのクリップ + 音声付き video クリップ(muted 除く)
}
