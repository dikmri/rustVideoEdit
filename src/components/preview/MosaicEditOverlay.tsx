// モザイク編集オーバーレイ(DESIGN.md §13.2)。
// mosaicEditMode 中、選択クリップ(video/image)のレイヤー上に領域矩形+コーナーハンドル 4 つ
// +回転ハンドル(上中央)を表示する。空き領域のドラッグで新規領域を作成(作成後選択)。
// ステージ座標⇔ソース座標は PlaybackEngine と同じ transform 値から DOMMatrix を組み立てて
// 逆行列で変換する。ドラッグ中は store を連打せずローカル state でプレビューし、
// pointerup 時に upsertMosaicKeyframe で確定する(±半フレーム以内の既存キーフレームは更新)。
import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { log } from "../../lib/logger";
import { sampleRegion } from "../../lib/mosaic";
import type { MosaicSample } from "../../lib/mosaic";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Clip, ClipTransform, MediaAsset } from "../../types/model";

/** スクリーン px 基準のハンドル寸法(ステージスケールで割ってステージ座標へ換算する)。 */
const CORNER_HANDLE_SCREEN_PX = 8;
const ROTATE_HANDLE_RADIUS_SCREEN_PX = 5;
const ROTATE_HANDLE_OFFSET_SCREEN_PX = 24;
/** 新規作成とみなす最小ドラッグサイズ(ソース px)。未満はクリック=選択解除扱い。 */
const MIN_CREATE_SIZE_SRC_PX = 4;
/** リサイズ時の最小領域サイズ(ソース px)。 */
const MIN_REGION_SIZE_SRC_PX = 8;

type DragMode = "move" | "rotate" | { corner: number };

interface DraftDrag {
  /** null = 新規作成ドラッグ中。 */
  regionId: string | null;
  sample: MosaicSample;
}

/**
 * ソースピクセル座標 → ステージ(プロジェクト解像度)座標の変換行列。
 * PlaybackEngine のレイヤー配置(left/top 50% + translate(-50%,-50%) translate(x,y)
 * rotate(r) scale(s)、transform-origin center)と等価:
 *   M = translate(W/2 + x, H/2 + y) · rotate(r) · scale(s) · translate(-srcW/2, -srcH/2)
 */
function sourceToStageMatrix(
  t: ClipTransform,
  srcW: number,
  srcH: number,
  stageW: number,
  stageH: number,
): DOMMatrix {
  return new DOMMatrix()
    .translate(stageW / 2 + t.x, stageH / 2 + t.y)
    .rotate(t.rotation)
    .scale(t.scale)
    .translate(-srcW / 2, -srcH / 2);
}

/** 領域矩形(ソース座標)の 4 隅を左上→右上→右下→左下の順で返す。 */
function rectCornersSrc(s: MosaicSample): DOMPoint[] {
  const rot = (s.rotation * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const hw = s.w / 2;
  const hh = s.h / 2;
  const local: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return local.map(([lx, ly]) => new DOMPoint(s.cx + lx * cos - ly * sin, s.cy + lx * sin + ly * cos));
}

function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

export function MosaicEditOverlay({ stageScale }: { stageScale: number }): JSX.Element | null {
  const mosaicEditMode = useUIStore((s) => s.mosaicEditMode);
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const selectedRegionId = useUIStore((s) => s.selectedMosaicRegionId);
  const playhead = useUIStore((s) => s.playhead);
  const project = useProjectStore((s) => s.project);
  const [draft, setDraft] = useState<DraftDrag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!mosaicEditMode) return null;

  const clipId = selectedClipIds[0] ?? null;
  if (!clipId) return null;

  let clip: Clip | null = null;
  for (const track of project.videoTracks) {
    const found = track.clips.find((c) => c.id === clipId);
    if (found) {
      clip = found;
      break;
    }
  }
  if (!clip || clip.text !== null || clip.assetId === null) return null;
  const asset: MediaAsset | null = project.assets.find((a) => a.id === clip!.assetId) ?? null;
  if (!asset || asset.kind === "audio") return null;
  // 選択クリップが playhead 下にあるとき(=プレビューにフレームが出ているとき)のみ編集可能。
  if (playhead < clip.start || playhead >= clip.start + clip.duration) return null;

  const stageW = project.settings.width;
  const stageH = project.settings.height;
  const srcW = asset.width ?? stageW;
  const srcH = asset.height ?? stageH;
  const toStage = sourceToStageMatrix(clip.transform, srcW, srcH, stageW, stageH);
  const toSource = toStage.inverse();
  const tLocal = Math.min(Math.max(playhead - clip.start, 0), clip.duration);
  const safeScale = stageScale > 0 ? stageScale : 1;

  const targetClip = clip;

  function clientToStage(clientX: number, clientY: number): DOMPoint {
    const svg = svgRef.current;
    if (!svg) return new DOMPoint(0, 0);
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return new DOMPoint(0, 0);
    return new DOMPoint(((clientX - rect.left) / rect.width) * stageW, ((clientY - rect.top) / rect.height) * stageH);
  }

  function clientToSource(clientX: number, clientY: number): DOMPoint {
    return toSource.transformPoint(clientToStage(clientX, clientY));
  }

  function commitKeyframe(regionId: string, sample: MosaicSample): void {
    useProjectStore.getState().upsertMosaicKeyframe(targetClip.id, regionId, { time: tLocal, ...sample });
  }

  /** 既存領域の移動/リサイズ/回転ドラッグ。 */
  function startRegionDrag(e: ReactPointerEvent, regionId: string, mode: DragMode): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const region = targetClip.mosaics.find((r) => r.id === regionId);
    if (!region) return;
    const base = sampleRegion(region, tLocal);
    if (!base) return;

    useUIStore.getState().setSelectedMosaicRegionId(regionId);

    const startSrc = clientToSource(e.clientX, e.clientY);
    let current: MosaicSample = { ...base };
    let moved = false;
    setDraft({ regionId, sample: current });

    const handleMove = (ev: PointerEvent): void => {
      moved = true;
      const p = clientToSource(ev.clientX, ev.clientY);
      if (mode === "move") {
        current = { ...base, cx: base.cx + (p.x - startSrc.x), cy: base.cy + (p.y - startSrc.y) };
      } else if (mode === "rotate") {
        const deg = (Math.atan2(p.y - base.cy, p.x - base.cx) * 180) / Math.PI + 90;
        current = { ...base, rotation: normalizeAngle(deg) };
      } else {
        // コーナーリサイズ: 対角コーナーを固定し、矩形の回転系ローカル座標で幅/高さを求める。
        const corners = rectCornersSrc(base);
        const anchor = corners[(mode.corner + 2) % 4];
        const rot = (base.rotation * Math.PI) / 180;
        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);
        const dx = p.x - anchor.x;
        const dy = p.y - anchor.y;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        const w = Math.max(MIN_REGION_SIZE_SRC_PX, Math.abs(lx));
        const h = Math.max(MIN_REGION_SIZE_SRC_PX, Math.abs(ly));
        // 新しい中心 = 固定コーナーとポインタの中点(ローカル)をソース座標へ戻す。
        const mx = lx / 2;
        const my = ly / 2;
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);
        current = {
          ...base,
          cx: anchor.x + mx * cosR - my * sinR,
          cy: anchor.y + mx * sinR + my * cosR,
          w,
          h,
        };
      }
      setDraft({ regionId, sample: current });
    };

    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      setDraft(null);
      if (moved) {
        commitKeyframe(regionId, current);
        const modeLabel = mode === "move" ? "move" : mode === "rotate" ? "rotate" : "resize";
        log.info("ui", `モザイク領域編集: clipId=${targetClip.id} regionId=${regionId} mode=${modeLabel}`);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  /** 空き領域ドラッグで新規領域を作成する。クリックのみ(閾値未満)は選択解除。 */
  function startCreateDrag(e: ReactPointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const startSrc = clientToSource(e.clientX, e.clientY);
    let current: MosaicSample | null = null;

    const handleMove = (ev: PointerEvent): void => {
      const p = clientToSource(ev.clientX, ev.clientY);
      const w = Math.abs(p.x - startSrc.x);
      const h = Math.abs(p.y - startSrc.y);
      current = {
        cx: (startSrc.x + p.x) / 2,
        cy: (startSrc.y + p.y) / 2,
        w,
        h,
        rotation: 0,
        visible: true,
      };
      setDraft({ regionId: null, sample: current });
    };

    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      setDraft(null);
      if (current && current.w >= MIN_CREATE_SIZE_SRC_PX && current.h >= MIN_CREATE_SIZE_SRC_PX) {
        const store = useProjectStore.getState();
        const newId = store.addMosaicRegion(targetClip.id, tLocal);
        if (newId) {
          store.upsertMosaicKeyframe(targetClip.id, newId, { time: tLocal, ...current });
          useUIStore.getState().setSelectedMosaicRegionId(newId);
        }
      } else {
        useUIStore.getState().setSelectedMosaicRegionId(null);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  // 描画データ: ドラッグ中の領域は draft を、それ以外は補間値を使う。
  const regionRects = targetClip.mosaics.map((region) => {
    const sample = draft && draft.regionId === region.id ? draft.sample : sampleRegion(region, tLocal);
    return { region, sample };
  });

  const cornerSizeStage = CORNER_HANDLE_SCREEN_PX / safeScale;
  const rotateRadiusStage = ROTATE_HANDLE_RADIUS_SCREEN_PX / safeScale;
  const rotateOffsetStage = ROTATE_HANDLE_OFFSET_SCREEN_PX / safeScale;

  return (
    <svg
      ref={svgRef}
      className="mosaic-edit-overlay"
      viewBox={`0 0 ${stageW} ${stageH}`}
      preserveAspectRatio="none"
      style={{ "--mosaic-sw": `${1 / safeScale}px` } as CSSProperties}
      onPointerDown={startCreateDrag}
    >
      {/* 背景(空き領域)のヒット面。 */}
      <rect x={0} y={0} width={stageW} height={stageH} fill="transparent" />

      {regionRects.map(({ region, sample }) => {
        if (!sample) return null;
        const cornersStage = rectCornersSrc(sample).map((p) => toStage.transformPoint(p));
        const points = cornersStage.map((p) => `${p.x},${p.y}`).join(" ");
        const isSelected = region.id === selectedRegionId;

        let handles: JSX.Element | null = null;
        if (isSelected) {
          const centerStage = toStage.transformPoint(new DOMPoint(sample.cx, sample.cy));
          // 上辺中央(ステージ座標)から中心の反対方向へ一定スクリーン距離だけ離した位置に回転ハンドル。
          const topCenterStage = new DOMPoint(
            (cornersStage[0].x + cornersStage[1].x) / 2,
            (cornersStage[0].y + cornersStage[1].y) / 2,
          );
          let dirX = topCenterStage.x - centerStage.x;
          let dirY = topCenterStage.y - centerStage.y;
          const len = Math.hypot(dirX, dirY);
          if (len > 1e-6) {
            dirX /= len;
            dirY /= len;
          } else {
            dirX = 0;
            dirY = -1;
          }
          const rotateX = topCenterStage.x + dirX * rotateOffsetStage;
          const rotateY = topCenterStage.y + dirY * rotateOffsetStage;

          handles = (
            <g>
              <line
                className="mosaic-rotate-line"
                x1={topCenterStage.x}
                y1={topCenterStage.y}
                x2={rotateX}
                y2={rotateY}
              />
              <circle
                className="mosaic-rotate-handle"
                cx={rotateX}
                cy={rotateY}
                r={rotateRadiusStage}
                onPointerDown={(e) => startRegionDrag(e, region.id, "rotate")}
              />
              {cornersStage.map((p, i) => (
                <rect
                  key={i}
                  className="mosaic-corner-handle"
                  x={p.x - cornerSizeStage / 2}
                  y={p.y - cornerSizeStage / 2}
                  width={cornerSizeStage}
                  height={cornerSizeStage}
                  onPointerDown={(e) => startRegionDrag(e, region.id, { corner: i })}
                />
              ))}
            </g>
          );
        }

        return (
          <g key={region.id} className={sample.visible ? "" : "mosaic-region-hidden"}>
            <polygon
              className={[
                "mosaic-region-rect",
                isSelected ? "mosaic-region-rect-selected" : "",
                region.enabled ? "" : "mosaic-region-rect-disabled",
              ]
                .filter(Boolean)
                .join(" ")}
              points={points}
              onPointerDown={(e) => startRegionDrag(e, region.id, "move")}
            />
            {handles}
          </g>
        );
      })}

      {/* 新規作成ドラッグ中のプレビュー矩形。 */}
      {draft && draft.regionId === null && (
        <polygon
          className="mosaic-region-rect mosaic-region-rect-creating"
          points={rectCornersSrc(draft.sample)
            .map((p) => toStage.transformPoint(p))
            .map((p) => `${p.x},${p.y}`)
            .join(" ")}
        />
      )}
    </svg>
  );
}
