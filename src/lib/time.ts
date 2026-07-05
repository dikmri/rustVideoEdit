// 秒⇔タイムコード変換(DESIGN.md §7, §9)。

/**
 * 秒数をタイムコード文字列 "HH:MM:SS:FF" に変換する。
 * @param sec 秒数(負値は 0 に丸める)
 * @param fps プロジェクトのフレームレート
 */
export function formatTimecode(sec: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const totalSeconds = Math.max(0, sec);
  const totalFrames = Math.round(totalSeconds * safeFps);

  const framesPerSecond = Math.round(safeFps);
  const frames = totalFrames % framesPerSecond;
  const totalWholeSeconds = Math.floor(totalFrames / framesPerSecond);
  const seconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad = (n: number): string => n.toString().padStart(2, "0");

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * 秒数を短い "mm:ss"(1 時間以上は "H:MM:SS")形式に変換する(MediaBin のクリップ長表示用)。
 */
export function formatDurationShort(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}
