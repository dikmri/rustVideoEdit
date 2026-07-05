# rustVideoEdit

Rust(Tauri 2)製の軽量・高速なクロスプラットフォーム動画編集ソフト。
シンプルで美しい UI を目指しています。

![CI](https://github.com/dikmri/rustVideoEdit/actions/workflows/ci.yml/badge.svg)

## 特長

- **軽量・高速**: Rust バックエンド + WebView フロントエンド(Tauri 2)。数百 MB 級の Electron 系エディタと比べ大幅に軽量
- **マルチトラック編集**: 複数のビデオ/オーディオトラック、クリップの移動・トリム・分割(レザー)・リップル削除・スナップ
- **リアルタイムプレビュー**: レイヤー合成方式のプレビュー(transform / 不透明度 / エフェクト / フェードを即時反映)
- **エフェクト**: 位置・スケール・回転・不透明度・速度(0.25〜4x)・音量・フェードイン/アウト・明るさ/コントラスト/彩度・ブラー
- **テキスト/タイトル**: フォント・サイズ・色・太字・揃え・背景ボックス
- **書き出し**: ffmpeg による H.264 / H.265 / ProRes 書き出し(プリセット+詳細設定、進捗表示、キャンセル)
- **多言語対応**: 日本語 / English / 简体中文 / 한국어 / Deutsch / Français / Español
- **自動更新**: 新バージョン公開時にアプリ内から 1 クリックで更新
- **undo/redo**: 全編集操作に対応(最大 100 段)

## 動作要件

- Windows 10/11、macOS、Linux
- **ffmpeg / ffprobe**(PATH に存在すること。または実行ファイル隣の `bin/` フォルダに配置)
  - Windows: `winget install Gyan.FFmpeg` など
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` など

## インストール

[Releases](https://github.com/dikmri/rustVideoEdit/releases/latest) から各プラットフォーム向けのインストーラをダウンロードしてください。

| OS | ファイル |
|---|---|
| Windows | `*-setup.exe`(NSIS) |
| macOS (Apple Silicon / Intel) | `*.dmg` |
| Linux | `*.AppImage` / `*.deb` |

## 開発

```bash
bun install
bun tauri dev      # 開発起動
bun tauri build    # リリースビルド
```

- 設計書: [docs/DESIGN.md](docs/DESIGN.md)
- ログ: 開発時はリポジトリ直下 `runtime/logs/`、インストール版は実行ファイル隣の `runtime/logs/` に出力されます

## リリース手順(メンテナ向け)

1. `src-tauri/tauri.conf.json` と `package.json` の version を上げる
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. GitHub Actions が全プラットフォームのビルドと Release 作成、`latest.json`(自動更新用)の生成まで行います

## ライセンス

[MIT](LICENSE)
