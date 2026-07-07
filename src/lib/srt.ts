// SRT 字幕の素朴なパーサ(DESIGN.md §14.2)。
// `番号(任意) → HH:MM:SS,mmm --> HH:MM:SS,mmm → 本文(複数行可)` のブロックが
// 空行区切りで並ぶ形式を想定する。BOM/CRLF を許容し、認識できないキューはスキップして
// logger.warn する(壊れた 1 キューのために全体の読み込みを失敗させない)。
import { log } from "./logger";

export interface SrtCue {
  start: number;
  end: number;
  text: string;
}

// "," 区切り(標準)・"." 区切り(一部ツールの出力)のどちらも許容する。時は桁数不定を許す。
const TIME_RE = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/;

/** ファイル先頭の UTF-8 BOM(U+FEFF)。 */
const BOM_RE = /^﻿/;

function parseTimecode(h: string, m: string, s: string, ms: string): number {
  const msNorm = ms.padEnd(3, "0").slice(0, 3);
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(msNorm) / 1000;
}

/**
 * SRT テキストをキュー配列へパースする(DESIGN §14.2)。不正なキュー(タイムコード行を
 * 認識できない・end<=start・本文が空)はスキップし、それぞれ logger.warn を 1 件ずつ記録する。
 */
export function parseSrt(raw: string): SrtCue[] {
  // BOM 除去 + CRLF/CR を LF へ統一(DESIGN §14.2: BOM/CRLF 許容)。
  const text = raw.replace(BOM_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = text.split(/\n\s*\n/);
  const cues: SrtCue[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const lines = block.split("\n");

    // 先頭行が数字のみの連番なら読み飛ばす(無い形式も許容する)。
    let idx = 0;
    if (/^\d+$/.test(lines[idx]?.trim() ?? "")) idx++;

    const timeLine = lines[idx]?.trim() ?? "";
    const m = TIME_RE.exec(timeLine);
    if (!m) {
      log.warn("srt", `不正なキューをスキップしました(タイムコード行を認識できません): "${lines[0] ?? ""}"`);
      continue;
    }

    const start = parseTimecode(m[1], m[2], m[3], m[4]);
    const end = parseTimecode(m[5], m[6], m[7], m[8]);
    if (!(end > start)) {
      log.warn("srt", `不正なキューをスキップしました(終了時刻が開始時刻以下です): "${timeLine}"`);
      continue;
    }

    const content = lines
      .slice(idx + 1)
      .join("\n")
      .trim();
    if (!content) {
      log.warn("srt", `不正なキューをスキップしました(本文が空です): "${timeLine}"`);
      continue;
    }

    cues.push({ start, end, text: content });
  }

  return cues;
}
