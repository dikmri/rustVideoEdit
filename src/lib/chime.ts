// 書き出し完了音(DESIGN.md §13.4)。WebAudio によるランタイム合成(音源ファイル不使用)。
// - playSuccessChime(): 「ポポンッ」= G5(783.99Hz) 0ms → G5 110ms → D6(1174.66Hz) 220ms。
//   各音は sine + 1 オクターブ上(gain 0.3)の 2 オシレータ構成、
//   exponentialRampToValueAtTime で減衰(1・2 音目 0.4 秒、3 音目のみ 0.6 秒)。マスター gain 0.22。
// - playErrorTone(): 220Hz 単音 0.25 秒(控えめ)。
import { log } from "./logger";

const G5_HZ = 783.99;
const D6_HZ = 1174.66;

/** AudioContext はアプリで 1 つを使い回す(生成失敗時は null のまま)。 */
let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }
    return audioContext;
  } catch (err) {
    log.error("chime", `AudioContext の生成に失敗しました: ${String(err)}`);
    return null;
  }
}

/**
 * 単音を鳴らす: 基音 sine + 1 オクターブ上(gain 0.3)の 2 オシレータを、
 * startAt から decaySec かけて指数減衰させる。
 */
function playNote(
  ctx: AudioContext,
  destination: AudioNode,
  freq: number,
  startAt: number,
  decaySec: number,
): void {
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(1, startAt);
  envelope.gain.exponentialRampToValueAtTime(0.001, startAt + decaySec);
  envelope.connect(destination);

  const partials: Array<[number, number]> = [
    [freq, 1],
    [freq * 2, 0.3], // 1 オクターブ上
  ];
  for (const [f, g] of partials) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    const oscGain = ctx.createGain();
    oscGain.gain.value = g;
    osc.connect(oscGain);
    oscGain.connect(envelope);
    osc.start(startAt);
    osc.stop(startAt + decaySec + 0.05);
  }
}

/** 書き出し成功音「ポポンッ」を再生する(§13.4)。 */
export function playSuccessChime(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = 0.22;
  master.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.02;
  playNote(ctx, master, G5_HZ, t0, 0.4);
  playNote(ctx, master, G5_HZ, t0 + 0.11, 0.4);
  playNote(ctx, master, D6_HZ, t0 + 0.22, 0.6); // 3 音目のみ長め
}

/** 書き出し失敗音(220Hz 単音 0.25 秒、控えめ)を再生する(§13.4)。 */
export function playErrorTone(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = 0.12; // 控えめ
  master.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.02;
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 220;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(1, t0);
  envelope.gain.setValueAtTime(1, t0 + 0.2);
  envelope.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
  osc.connect(envelope);
  envelope.connect(master);
  osc.start(t0);
  osc.stop(t0 + 0.3);
}
