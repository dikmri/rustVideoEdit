# rustVideoEdit 設計書

Premiere Pro のコア機能(クラウド以外)を再現する、Rust製クロスプラットフォーム動画編集ソフト。
軽量・高速・ネイティブ並パフォーマンス。UI/UX は無印良品風(シンプル・余白・生成り色)。

この文書が唯一の仕様書。実装エージェントは必ず全文を読み、逸脱しないこと。

---

## 1. 技術スタック

| 層 | 技術 |
|---|---|
| シェル | Tauri 2 (`tauri = "2"`) |
| フロント | React 18 + TypeScript + Vite 6、状態管理 Zustand(+ zundo で undo/redo) |
| パッケージ管理 | bun(npm/yarn/pnpm 禁止) |
| i18n | i18next + react-i18next |
| 映像エンジン | システムの ffmpeg / ffprobe(実行ファイルを子プロセス起動) |
| ログ | Rust: tracing + tracing-appender / フロント: IPC で同一ファイルへ |
| 自動更新 | tauri-plugin-updater + tauri-plugin-process |
| CI/CD | GitHub Actions + tauri-apps/tauri-action(タグ push で自動リリース) |

Rust 依存(src-tauri/Cargo.toml): `tauri = { version = "2", features = [] }`,
`tauri-plugin-dialog = "2"`, `tauri-plugin-updater = "2"`, `tauri-plugin-process = "2"`,
`tauri-plugin-opener = "2"`, `serde`, `serde_json`, `uuid = { version = "1", features = ["v4"] }`,
`tracing`, `tracing-subscriber`, `tracing-appender`, `chrono`, `dirs = "5"`(不要なら省く)。
非同期は tauri の async コマンド(tokio は tauri 同梱のものを利用)。

フロント依存: `react`, `react-dom`, `zustand`, `zundo`, `i18next`, `react-i18next`,
`@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-updater`,
`@tauri-apps/plugin-process`, `@tauri-apps/plugin-opener`。
dev: `@tauri-apps/cli`, `typescript`, `vite`, `@vitejs/plugin-react`。

- アプリ識別子: `com.dikmri.rustvideoedit`
- productName: `rustVideoEdit`、初期バージョン `0.1.0`
- GitHub: `dikmri/rustVideoEdit`(public)

## 2. ディレクトリ構成

```
rustVideoEdit/
├─ package.json / bun.lock / vite.config.ts / tsconfig.json / index.html
├─ assets/icon.png                  # アイコン元画像(1024x1024)
├─ src/                             # フロントエンド
│  ├─ main.tsx / App.tsx
│  ├─ styles/tokens.css             # デザイントークン(§9)
│  ├─ styles/base.css               # リセット+共通部品(ボタン等)
│  ├─ i18n/index.ts
│  ├─ i18n/locales/{ja,en,zh-CN,ko,de,fr,es}.json
│  ├─ types/model.ts                # §4 のデータモデル(唯一の型定義箇所)
│  ├─ lib/ipc.ts                    # invoke ラッパ(全コマンドの型付き関数)
│  ├─ lib/logger.ts                 # log.info/warn/error → IPC log_event
│  ├─ lib/time.ts                   # 秒⇔タイムコード変換等
│  ├─ lib/exportSpec.ts             # Project → ExportSpec 変換(§8)
│  ├─ lib/playback/PlaybackEngine.ts # プレビュー同期エンジン(§7)
│  ├─ stores/projectStore.ts        # プロジェクト状態+undo/redo(zundo)
│  ├─ stores/uiStore.ts             # 選択・ツール・ズーム・再生状態等
│  └─ components/
│     ├─ layout/Header.tsx          # メニューバー
│     ├─ mediabin/MediaBin.tsx
│     ├─ preview/PreviewPanel.tsx / PreviewSurface.tsx / TransportBar.tsx
│     ├─ timeline/Timeline.tsx / Ruler.tsx / TrackHeader.tsx / TrackLane.tsx / ClipView.tsx / TimelineToolbar.tsx
│     ├─ properties/PropertiesPanel.tsx
│     ├─ export/ExportDialog.tsx
│     └─ dialogs/SettingsDialog.tsx / AboutDialog.tsx / UpdateBanner.tsx
├─ src-tauri/
│  ├─ Cargo.toml / build.rs / tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ icons/                        # bunx tauri icon で生成
│  └─ src/
│     ├─ main.rs                    # lib.rs の run() を呼ぶだけ
│     ├─ lib.rs                     # Builder 組立・plugin 登録・ログ初期化
│     ├─ logsys.rs                  # ログ初期化+log_event コマンド
│     ├─ paths.rs                   # runtime ディレクトリ解決(§6)
│     ├─ ffmpeg/mod.rs / locate.rs / probe.rs / filtergraph.rs / encode.rs
│     └─ commands/mod.rs / media.rs / project.rs / export.rs
├─ .github/workflows/ci.yml / release.yml
├─ docs/DESIGN.md(本書)
├─ runtime/                         # 開発時のログ・キャッシュ(gitignore)
├─ README.md / LICENSE(MIT) / .gitignore
```

## 3. 実行時パス規約(重要)

アプリが書き出すファイル(ログ・サムネイルキャッシュ・設定)は **OS 共通領域を使わず**、
`runtime_dir()` 配下に置く:

- デバッグビルド(`cfg(debug_assertions)`): `CARGO_MANIFEST_DIR` の親(=リポジトリ root)`/runtime`
- リリースビルド: 実行ファイルと同じディレクトリの `runtime`(作成失敗時のみ `dirs::data_local_dir()/rustVideoEdit` にフォールバック)

`runtime/logs/`(ログ)、`runtime/cache/thumbs/`(サムネイル)、`runtime/settings.json`(言語等)。

## 4. データモデル(src/types/model.ts が正)

時間は全て **秒(number/f64)**。ID は UUID v4 文字列。

```ts
export type AssetKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  path: string;            // 絶対パス
  name: string;            // ファイル名
  kind: AssetKind;
  duration: number;        // 画像は 0
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  codec: string | null;
  thumbnail: string | null; // キャッシュ画像の絶対パス
}

export interface ClipTransform { x: number; y: number; scale: number; rotation: number; }
// x,y: プロジェクト解像度基準の中心からのオフセット(px)。scale: 1=原寸。rotation: 度。

export type Effect =
  | { type: 'eq'; brightness: number; contrast: number; saturation: number } // b:-1..1(0), c:0..2(1), s:0..3(1)
  | { type: 'blur'; radius: number };                                        // 0..50(0)

export interface TextStyle {
  content: string; fontFamily: string; fontSize: number;  // px(プロジェクト解像度基準)
  color: string;          // #RRGGBB
  bold: boolean;
  align: 'left' | 'center' | 'right';
  background: string | null; // #RRGGBB or null
}

export interface Clip {
  id: string;
  assetId: string | null;  // null = テキストクリップ(video トラックのみ)
  start: number;           // タイムライン上の開始秒
  duration: number;        // タイムライン上の長さ(速度適用後)
  inPoint: number;         // ソース内 in 秒(source out = inPoint + duration*speed)
  speed: number;           // 0.25..4、画像/テキストは常に 1
  volume: number;          // 0..2
  muted: boolean;
  opacity: number;         // 0..1
  transform: ClipTransform;
  fadeIn: number;          // 秒。video=不透明度+音量、audio=音量
  fadeOut: number;
  effects: Effect[];
  text: TextStyle | null;  // テキストクリップのみ非 null
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  name: string;            // "V1","A1" 等
  locked: boolean;
  muted: boolean;
  clips: Clip[];           // start 昇順を維持。同一トラック内で重なり禁止
}

export interface ProjectSettings { width: number; height: number; fps: number; sampleRate: number; }

export interface Project {
  version: 1;
  name: string;
  settings: ProjectSettings;   // 既定 1920x1080 / 30fps / 48000
  assets: MediaAsset[];
  videoTracks: Track[];        // index 0 = V1 = 最下層。UI では逆順表示(上ほど上層)
  audioTracks: Track[];        // index 0 = A1。UI では video の下に A1, A2…
}
```

プロジェクトファイル: 拡張子 `.rvep`、内容は `Project` の JSON(UTF-8, pretty)。
Rust 側は保存/読込では中身を解釈しない(透過 JSON 文字列)。

規則:
- クリップ移動/トリムでは同一トラック内の重なりを禁止(衝突時は隣接位置へクランプ)
- 動画クリップの `inPoint + duration*speed <= asset.duration`(トリム上限)。画像・テキストは duration 自由
- 新規プロジェクト既定: videoTracks V1,V2 / audioTracks A1,A2(空)

## 5. IPC コマンド(src-tauri/src/commands/)

全コマンドは呼出時に引数概要を、終了時に結果/エラーを tracing で INFO/ERROR ログする。
戻り値の JSON キーは **camelCase**(serde `rename_all = "camelCase"`)。

```
check_ffmpeg() -> { ffmpeg: string|null, ffprobe: string|null, version: string|null }
  // locate.rs: PATH → exe隣 bin/ → runtime/bin/ の順で探索

probe_media(path: string) -> MediaAsset      // ffprobe -show_format -show_streams -of json
generate_thumbnail(assetId: string, path: string, timeSec: f64) -> string
  // runtime/cache/thumbs/{assetId}.jpg へ 320px 幅 JPEG。既存ならそのまま返す

save_project(path: string, json: string) -> ()
load_project(path: string) -> string
read_settings() -> string                    // runtime/settings.json(無ければ "{}")
write_settings(json: string) -> ()

log_event(level: string, target: string, message: string) -> ()   // フロントログ受け口

start_export(spec: ExportSpec) -> string     // jobId を返し非同期実行
cancel_export(jobId: string) -> ()
  // 進捗イベント emit: "export:progress" { jobId, ratio(0..1), outTimeSec, speed }
  //                    "export:done"     { jobId, outputPath }
  //                    "export:error"    { jobId, message }
list_system_fonts() -> string[]              // drawtext 用。Windows: C:\Windows\Fonts 列挙(名前のみ)、失敗時は既定リスト
```

`ExportSpec`(Rust 側 serde struct、フロント lib/exportSpec.ts が生成):

```ts
interface ExportSpec {
  outputPath: string;
  width: number; height: number; fps: number; sampleRate: number;
  durationSec: number;                        // タイムライン全長
  videoCodec: 'h264' | 'hevc' | 'prores';
  quality: number;                            // h264/hevc: CRF 値
  audioBitrateKbps: number;                   // aac 用(prores は pcm_s16le)
  inputs: { index: number; path: string; kind: AssetKind }[];  // index は ffmpeg -i の順
  videoClips: VClip[];   // 下層トラックから順(V1 の全クリップ→V2…)、各トラック内 start 昇順
  audioClips: AClip[];   // audio トラックのクリップ + 音声付き video クリップ(muted 除く)
}
interface VClip { inputIndex: number|null /* null=テキスト */; start,duration,inPoint,speed,opacity: number;
  transform: ClipTransform; fadeIn,fadeOut: number; effects: Effect[]; text: TextStyle|null;
  assetW: number|null; assetH: number|null; isImage: boolean; }
interface AClip { inputIndex: number; start,duration,inPoint,speed,volume,fadeIn,fadeOut: number; }
```

### capabilities/default.json
core:default、dialog:default、updater:default、process:default、opener:default に加え
`core:event:default`, `core:webview:allow-webview-*` は既定に含まれるものを使用。
tauri.conf.json では `app.security.assetProtocol = { enable: true, scope: ["**"] }` を設定
(プレビューでローカル動画を `convertFileSrc` 再生するため。CSP は `media-src asset: http://asset.localhost` 等を許可)。

## 6. ログ仕様(動作確認ループ用・必須)

- ファイル: `runtime/logs/rustVideoEdit-YYYY-MM-DD.log`(tracing-appender daily rolling)
- 形式: `2026-07-05T12:34:56.789+09:00 LEVEL [target] message`(1行1イベント、人間可読)
- Rust: 全コマンドの入口(`cmd=probe_media path=...`)と出口(`ok` / `err=...`)、ffmpeg 実行コマンドライン全文、終了コード
- フロント: `lib/logger.ts` 経由で UI イベントを記録(target=`ui`)
  - 記録対象: アプリ起動/言語切替、D&D(受領パス)、アセット追加/削除、クリップ追加/移動/トリム/分割/削除、
    再生/停止/シーク、プロパティ変更(名称と値)、書き出し開始/完了/失敗、保存/読込、undo/redo、エラー全般
  - `window.onerror` / `unhandledrejection` も logger.error へ
- 起動時にログパスを INFO で 1 行出力

## 7. プレビューエンジン(lib/playback/PlaybackEngine.ts)

HTML5 レイヤー合成方式(ffmpeg デコード不使用、リアルタイム再生):

- 各 video トラックに 1 つの `<video>`(または画像用 `<img>`)レイヤー要素、各 audio トラックに 1 つの `<audio>` を割当
- ステージ: プロジェクト解像度のアスペクト比を保つ黒背景 div。レイヤーは absolute 配置、
  CSS transform(translate/scale/rotate)+ opacity + filter(brightness/contrast/saturate/blur)で
  クリップの transform/effects を適用。テキストクリップは styled div で描画
- 再生クロック: `performance.now()` 基準。rAF ループで `playhead = base + elapsed` を更新
- 各フレームで: トラックごとに playhead 下のクリップを検索 →
  - src 差替(`convertFileSrc(asset.path)`)、`expected = inPoint + (playhead - clip.start) * speed`
  - `|media.currentTime - expected| > 0.12` なら currentTime を補正。`playbackRate = speed`
  - フェード: `opacity *= fadeFactor(t)`、音量 `volume = clip.volume * fadeFactor(t)`(0..1 に clamp)
  - クリップが無いトラックは要素を hidden + pause
- 停止時: 全要素 pause、シークは currentTime 直接設定(静止フレーム表示)
- 末尾(タイムライン全長)到達で自動停止
- WebView で再生不能なコーデックは `<video>` の error イベントで検知しレイヤーに「プレビュー非対応」表示(書き出しは可能)

## 8. 書き出し(ffmpeg filter_complex)— filtergraph.rs

`ExportSpec` から単一の ffmpeg コマンドを構築する。

- 入力: `inputs` 順に `-i path`。画像は `-loop 1 -t {durationの最大必要秒} -i path`
- 映像ベース: `color=c=black:s={W}x{H}:r={fps}:d={dur}[base]`
- 各 VClip i(下層→上層の順に overlay を連鎖):

```
[{in}:v] trim=start={inPoint}:end={inPoint+duration*speed},
 setpts=(PTS-STARTPTS)/{speed}+{start}/TB, fps={fps},
 scale=w=iw*{scale}:h=ih*{scale}, format=yuva420p,
 rotate={rot}*PI/180:ow='rotw({rot}*PI/180)':oh='roth({rot}*PI/180)':c=black@0,   # rot≠0 のみ
 eq=brightness={b}:contrast={c}:saturation={s},                                   # eq effect 時のみ
 gblur=sigma={radius},                                                            # blur effect 時のみ
 colorchannelmixer=aa={opacity},                                                  # opacity<1 のみ
 fade=t=in:st={start}:d={fadeIn}:alpha=1, fade=t=out:st={start+duration-fadeOut}:d={fadeOut}:alpha=1  # >0 のみ
 [v{i}];
[{prev}][v{i}] overlay=x=(W-w)/2+{tx}:y=(H-h)/2+{ty}:eval=init:enable='between(t,{start},{start+duration})' [m{i}];
```

  - 画像入力は trim の代わりに `setpts=PTS-STARTPTS+{start}/TB` と `trim=duration={duration}` 相当を
    `-t` 側で確保しつつ同様に処理(inPoint=0, speed=1)
  - テキストクリップ(inputIndex=null)は入力を作らず、直前の合成結果に対し
    `drawtext=text='{escaped}':fontsize={size}:fontcolor={color}:x=...:y=...:enable='between(t,...)'`
    (+`box=1:boxcolor={bg}@0.6`、`fontfile` は Windows なら `C\\:/Windows/Fonts/...` 形式でエスケープ)を適用
- 音声: 各 AClip j:

```
[{in}:a] atrim=start={inPoint}:end={inPoint+duration*speed}, asetpts=PTS-STARTPTS,
 atempo チェーン({speed}。0.5 未満は 0.5×0.5 のように分割),
 volume={volume},
 afade=t=in:st=0:d={fadeIn}, afade=t=out:st={duration-fadeOut}:d={fadeOut},
 adelay={round(start*1000)}:all=1, aresample={sampleRate} [a{j}];
[a0][a1]...amix=inputs={n}:normalize=0:duration=longest[aout];
```

  - AClip が 0 件なら `anullsrc=r={sampleRate}:cl=stereo[aout]`
- マップ: `-map [m{last}] -map [aout] -t {dur} -r {fps}`
- エンコード: h264 → `-c:v libx264 -preset medium -crf {q} -pix_fmt yuv420p -c:a aac -b:a {ab}k`、
  hevc → `-c:v libx265 -preset medium -crf {q} -tag:v hvc1 -pix_fmt yuv420p -c:a aac`、
  prores → `-c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -c:a pcm_s16le`(拡張子 .mov)
- 進捗: `-progress pipe:1 -nostats -y`。stdout の `out_time_ms=`(または `out_time=`)を読み
  `ratio = outTime/dur` を 200ms 間隔で emit。stderr は全行ログへ。cancel は子プロセス kill
- filter_complex はコマンドライン長対策で `-filter_complex_script` (一時ファイルを runtime/cache に書く) を使用

## 9. UI/UX 仕様(無印良品風)

### デザイントークン(styles/tokens.css)
```css
:root {
  --bg: #EFECE6;            /* 生成り(アプリ背景) */
  --panel: #F7F5F0;         /* パネル面 */
  --panel-deep: #E7E3DB;    /* タイムライン背景等の一段深い面 */
  --border: #D9D4CA;        /* 1px 罫線 */
  --text: #3C3A36;          /* 墨色 */
  --text-sub: #8A857C;
  --accent: #9E3B32;        /* 臙脂。選択枠・主要ボタン・録画的要素のみに限定使用 */
  --accent-soft: #C9776F;
  --clip-video: #A8B8BF;    /* 青灰 */
  --clip-audio: #A9BCA4;    /* 灰緑 */
  --clip-text: #C9B08C;     /* 亜麻 */
  --radius: 3px;
  --font: "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Segoe UI", system-ui, sans-serif;
}
```
- 影なし(または極薄)、線は 1px、角丸 3px、8px グリッドの余白。装飾を足さない
- ボタン: 枠線+文字のゴースト型が基本。主要アクション(書き出し等)のみ accent 塗り
- アイコンはインライン SVG(stroke 1.5px、currentColor)。絵文字禁止

### レイアウト
```
┌ Header(48px): アプリ名 / プロジェクト名(クリックでリネーム) | 新規・開く・保存 | 書き出し | 言語 / 設定 ┐
├───────────────┬──────────────────────────────┬───────────────┤
│ MediaBin(260px)│ Preview(可変・中央)          │ Properties(300px)│
├───────────────┴──────────────────────────────┴───────────────┤
│ Timeline(高さ 40%・上端ドラッグでリサイズ)                     │
└──────────────────────────────────────────────────────────────┘
```

### 各パネル
- **MediaBin**: 「メディアを追加」ボタン(dialog)+ OS からの D&D(Tauri の onDragDropEvent。
  webview の dragDropEnabled は true のまま)。サムネイル+名前+長さのグリッド。右クリックで削除。
  ダブルクリックでプレビュー確認は不要(選択のみ)。アイテムをポインタドラッグ(HTML5 DnD ではなく
  pointer イベント自作)でタイムラインへ配置
- **Preview**: 中央ステージ+下部 TransportBar(先頭へ / 1フレーム戻 / 再生・停止 / 1フレーム進 / 末尾へ、
  現在タイムコード / 全長)。タイムコードは HH:MM:SS:FF
- **Timeline**:
  - Toolbar: 選択(V)/レザー(C)ツール、クリップ分割、削除、リップル削除、スナップ on/off、
    テキストクリップ追加(T)、ズームスライダ+fit、トラック追加(V/A)
  - Ruler: 秒/フレーム目盛、クリック・ドラッグでシーク。Playhead は臙脂の縦線
  - TrackHeader(左 140px): 名前、ロック、ミュート。行高 video 64px / audio 48px
  - クリップ: 角丸矩形、色は種別トークン、左右 6px がトリムハンドル、選択中は accent 2px 枠。
    ドラッグ移動(同種トラック間移動可)、スナップ(他クリップ端・playhead・0 秒。閾値 8px)
  - レザーツールでクリップクリック→その位置で 2 分割
  - 重なり禁止ルール(§4)を UI 側で徹底
  - ズーム: pxPerSecond 10..400(既定 60)。Ctrl+ホイールでズーム、ホイールで横スクロール
- **Properties**: 選択クリップの kind に応じ表示。数値は drag可能な数値入力+スライダ。
  transform(x/y/scale/rotation)、opacity、speed、volume、muted、fadeIn/Out、effects(eq/blur の追加・削除)、
  テキスト(content/size/color/bold/align/background/font)。未選択時はプロジェクト設定(解像度/fps)を表示
- **ExportDialog**: プリセット(YouTube 1080p / 4K / HD 720p / ProRes マスター)+詳細(コーデック/解像度/fps/CRF/音声kbps)、
  保存先(dialog)、進捗バー+速度表示+キャンセル。完了時に「フォルダを開く」(opener)

### ショートカット
Space 再生/停止、J/K/L(逆再生は seek -1s 連打で近似可、K 停止、L 再生)、←/→ 1フレーム、
Home/End、V/C ツール、T テキスト追加、S スナップ切替、Ctrl+S 保存、Ctrl+O 開く、Ctrl+N 新規、
Ctrl+Z / Ctrl+Shift+Z(または Ctrl+Y) undo/redo、Delete 削除、Shift+Delete リップル削除、
Ctrl+K 再生ヘッド位置で分割、Ctrl+E 書き出し、Ctrl+= / Ctrl+- ズーム

### undo/redo
zundo で `projectStore` の Project 部分のみ履歴化(limit 100、300ms デバウンス)。
再生ヘッド・選択・ズーム等 UI 状態は対象外。

## 10. i18n

- `i18n/locales/*.json` フラットキー(例 `"header.export": "書き出し"`)。ja を基準に全キー同一
- 対応: ja(既定)、en、zh-CN、ko、de、fr、es
- 初期言語: settings.json → 無ければ `navigator.language` から推定 → fallback en
- Header の言語メニューで即時切替、write_settings で永続化

## 11. 自動更新・リリース

- tauri.conf.json: `bundle.createUpdaterArtifacts: true`、plugins.updater に
  endpoint `https://github.com/dikmri/rustVideoEdit/releases/latest/download/latest.json` と pubkey
- 起動 3 秒後に check() → 更新ありなら Header 直下に UpdateBanner(「新しいバージョン vX.Y.Z」
  + 「更新して再起動」ボタン → downloadAndInstall → relaunch)。失敗は握りつぶしてログのみ
- `.github/workflows/release.yml`: `push: tags: ['v*']` で tauri-action。
  matrix: windows-latest / macos-latest(aarch64-apple-darwin, x86_64-apple-darwin) / ubuntu-22.04。
  Linux は依存 `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` を apt install。
  env: TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD(GitHub Secrets)。
  includeUpdaterJson: true、releaseDraft: false、tagName: `v__VERSION__`
- `.github/workflows/ci.yml`: push/PR(main)で `bun install` → `tsc --noEmit` → `bun run build` →
  `cargo fmt --check` → `cargo clippy -- -D warnings`(ubuntu のみ、webkit 依存 install)

## 12. 実装フェーズ

1. **P1 基盤**: スキャフォールド、Rust 全コマンド、ログ、ffmpeg 連携、filter graph、cargo check 通過
2. **P2 フロント基盤**: トークン/レイアウト/i18n/ストア/MediaBin/Preview/Properties
3. **P3 タイムライン+書き出しUI**: Timeline 全操作、ExportDialog、ショートカット、undo/redo
4. **P4 リリース**: アイコン、CI/CD、updater 鍵、GitHub 公開、v0.1.0 リリース

各フェーズ完了時に `bun run build`(tsc 含む)と `cargo check` を必ず通すこと。
