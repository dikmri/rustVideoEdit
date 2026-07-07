// 選択クリップ or プロジェクト設定のプロパティフォーム(DESIGN.md §9)。
// 変更は projectStore.updateClip / setSettings 経由(logger.info も記録する)。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listSystemFonts } from "../../lib/ipc";
import { log } from "../../lib/logger";
import { MOSAIC_BLOCK_SIZE_MAX, MOSAIC_BLOCK_SIZE_MIN } from "../../lib/mosaic";
import { recordMosaicKeyframeAtPlayhead } from "../../lib/mosaicActions";
import { formatTimecode } from "../../lib/time";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type { Clip, Effect, ProjectSettings, TransitionType } from "../../types/model";
import { DragNumber } from "./DragNumber";

/** トランジション種別(DESIGN.md §14.1)。テキストクリップは dissolve のみ許可。 */
const TRANSITION_TYPES: TransitionType[] = [
  "dissolve",
  "wipeleft",
  "wiperight",
  "wipeup",
  "wipedown",
  "slideleft",
  "slideright",
];

/** トランジション長を 0.1..min(3, clip.duration) にクランプする(§14.1)。 */
function clampTransitionDuration(value: number, clipDuration: number): number {
  const max = Math.min(3, clipDuration);
  return Math.min(max, Math.max(0.1, value));
}

const RESOLUTION_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "1280x720", width: 1280, height: 720 },
  { label: "3840x2160", width: 3840, height: 2160 },
];

const FPS_OPTIONS = [24, 30, 60];

let cachedFonts: string[] | null = null;

function useSystemFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>(cachedFonts ?? []);
  useEffect(() => {
    if (cachedFonts) return;
    listSystemFonts()
      .then((list) => {
        cachedFonts = list;
        setFonts(list);
      })
      .catch((err) => {
        log.error("properties", `フォント一覧の取得に失敗しました: ${String(err)}`);
      });
  }, []);
  return fonts;
}

export function PropertiesPanel(): JSX.Element {
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const selectedClipId = selectedClipIds[0] ?? null;

  // クリップの内容(assets を含む)が変わったら再描画されるよう project 全体を購読する。
  const project = useProjectStore((s) => s.project);
  const clip = selectedClipId
    ? ([...project.videoTracks, ...project.audioTracks].flatMap((tr) => tr.clips).find((c) => c.id === selectedClipId) ?? null)
    : null;

  if (!clip) {
    return <ProjectSettingsForm settings={project.settings} />;
  }

  return <ClipPropertiesForm key={clip.id} clip={clip} />;
}

function ProjectSettingsForm({ settings }: { settings: ProjectSettings }): JSX.Element {
  const { t } = useTranslation();
  const matchedPreset = RESOLUTION_PRESETS.find((p) => p.width === settings.width && p.height === settings.height);

  function applyPreset(label: string): void {
    const preset = RESOLUTION_PRESETS.find((p) => p.label === label);
    if (!preset) return;
    useProjectStore.getState().setSettings({ width: preset.width, height: preset.height });
    log.info("ui", `プロジェクト解像度変更: ${preset.width}x${preset.height}`);
  }

  function applyWidth(width: number): void {
    useProjectStore.getState().setSettings({ width: Math.round(width) });
    log.info("ui", `プロジェクト幅変更: ${Math.round(width)}`);
  }

  function applyHeight(height: number): void {
    useProjectStore.getState().setSettings({ height: Math.round(height) });
    log.info("ui", `プロジェクト高さ変更: ${Math.round(height)}`);
  }

  function applyFps(fps: number): void {
    useProjectStore.getState().setSettings({ fps });
    log.info("ui", `プロジェクト fps 変更: ${fps}`);
  }

  return (
    <div className="properties-panel">
      <h2 className="properties-title">{t("properties.title")}</h2>
      <div className="properties-section">
        <h3 className="properties-section-title">{t("properties.projectSettings")}</h3>
        <div className="properties-row">
          <label>{t("properties.resolution")}</label>
          <select value={matchedPreset?.label ?? "custom"} onChange={(e) => applyPreset(e.target.value)}>
            {RESOLUTION_PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
            <option value="custom">{t("properties.resolutionCustom")}</option>
          </select>
        </div>
        <div className="properties-row">
          <label>{t("properties.width")}</label>
          <DragNumber value={settings.width} min={16} max={7680} precision={0} step={2} onChange={applyWidth} />
        </div>
        <div className="properties-row">
          <label>{t("properties.height")}</label>
          <DragNumber value={settings.height} min={16} max={4320} precision={0} step={2} onChange={applyHeight} />
        </div>
        <div className="properties-row">
          <label>{t("properties.fps")}</label>
          <select value={settings.fps} onChange={(e) => applyFps(Number(e.target.value))}>
            {FPS_OPTIONS.map((fps) => (
              <option key={fps} value={fps}>
                {fps}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function ClipPropertiesForm({ clip }: { clip: Clip }): JSX.Element {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const asset = clip.assetId ? (project.assets.find((a) => a.id === clip.assetId) ?? null) : null;
  const isText = clip.text !== null;
  const isImage = asset?.kind === "image";
  const isAudioAsset = asset?.kind === "audio";
  const hasAudio = !isText && !isImage; // video/audio アセットは音量制御あり
  const speedEditable = !isText && !isImage;
  // 音声切り離し(§14.3)対象: hasAudio な video クリップ(テキスト除く)。既にミュート済みなら再表示不要。
  const canDetachAudio = asset?.kind === "video" && asset.hasAudio && !clip.muted;

  function update(partial: Partial<Clip>): void {
    useProjectStore.getState().updateClip(clip.id, partial);
  }

  function updateAndLog(partial: Partial<Clip>, label: string): void {
    update(partial);
    log.info("ui", `プロパティ変更: clipId=${clip.id} ${label}`);
  }

  // ログは projectStore.detachAudio 内で記録するため、ここでは呼び出しのみ行う(二重記録防止)。
  function handleDetachAudio(): void {
    useProjectStore.getState().detachAudio(clip.id);
  }

  const kindLabel = isText
    ? t("properties.clipText")
    : isImage
      ? t("properties.clipImage")
      : isAudioAsset
        ? t("properties.clipAudio")
        : t("properties.clipVideo");

  return (
    <div className="properties-panel">
      <h2 className="properties-title">{kindLabel}</h2>

      {!isAudioAsset && (
        <div className="properties-section">
          <h3 className="properties-section-title">{t("properties.transform")}</h3>
          <div className="properties-row">
            <label>{t("properties.x")}</label>
            <DragNumber
              value={clip.transform.x}
              precision={0}
              onChange={(v) => update({ transform: { ...clip.transform, x: v } })}
              onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} transform.x=${clip.transform.x}`)}
            />
          </div>
          <div className="properties-row">
            <label>{t("properties.y")}</label>
            <DragNumber
              value={clip.transform.y}
              precision={0}
              onChange={(v) => update({ transform: { ...clip.transform, y: v } })}
              onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} transform.y=${clip.transform.y}`)}
            />
          </div>
          <div className="properties-row">
            <label>{t("properties.scale")}</label>
            <DragNumber
              value={clip.transform.scale}
              min={0.01}
              max={10}
              step={0.01}
              precision={2}
              onChange={(v) => update({ transform: { ...clip.transform, scale: v } })}
              onCommit={() =>
                log.info("ui", `プロパティ変更: clipId=${clip.id} transform.scale=${clip.transform.scale}`)
              }
            />
          </div>
          <div className="properties-row">
            <label>{t("properties.rotation")}</label>
            <DragNumber
              value={clip.transform.rotation}
              step={1}
              precision={0}
              suffix="°"
              onChange={(v) => update({ transform: { ...clip.transform, rotation: v } })}
              onCommit={() =>
                log.info("ui", `プロパティ変更: clipId=${clip.id} transform.rotation=${clip.transform.rotation}`)
              }
            />
          </div>
          <div className="properties-row">
            <label>{t("properties.opacity")}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={clip.opacity}
              onChange={(e) => update({ opacity: Number(e.target.value) })}
              onPointerUp={() => log.info("ui", `プロパティ変更: clipId=${clip.id} opacity=${clip.opacity}`)}
            />
            <DragNumber
              value={clip.opacity}
              min={0}
              max={1}
              step={0.01}
              precision={2}
              onChange={(v) => update({ opacity: v })}
              onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} opacity=${clip.opacity}`)}
            />
          </div>
        </div>
      )}

      {speedEditable && (
        <div className="properties-section">
          <div className="properties-row">
            <label>{t("properties.speed")}</label>
            <DragNumber
              value={clip.speed}
              min={0.25}
              max={4}
              step={0.01}
              precision={2}
              suffix="x"
              onChange={(v) => update({ speed: v })}
              onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} speed=${clip.speed}`)}
            />
          </div>
        </div>
      )}

      {hasAudio && (
        <div className="properties-section">
          <h3 className="properties-section-title">{t("properties.volume")}</h3>
          <div className="properties-row">
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={clip.volume}
              onChange={(e) => update({ volume: Number(e.target.value) })}
              onPointerUp={() => log.info("ui", `プロパティ変更: clipId=${clip.id} volume=${clip.volume}`)}
            />
            <DragNumber
              value={clip.volume}
              min={0}
              max={2}
              step={0.01}
              precision={2}
              onChange={(v) => update({ volume: v })}
              onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} volume=${clip.volume}`)}
            />
          </div>
          <label className="row properties-checkbox">
            <input
              type="checkbox"
              checked={clip.muted}
              onChange={(e) => updateAndLog({ muted: e.target.checked }, `muted=${e.target.checked}`)}
            />
            {t("properties.muted")}
          </label>
          {canDetachAudio && (
            <button className="btn" onClick={handleDetachAudio}>
              {t("properties.detachAudio")}
            </button>
          )}
        </div>
      )}

      <div className="properties-section">
        <div className="properties-row">
          <label>{t("properties.fadeIn")}</label>
          <DragNumber
            value={clip.fadeIn}
            min={0}
            max={clip.duration}
            step={0.05}
            precision={2}
            suffix="s"
            onChange={(v) => update({ fadeIn: v })}
            onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} fadeIn=${clip.fadeIn}`)}
          />
        </div>
        <div className="properties-row">
          <label>{t("properties.fadeOut")}</label>
          <DragNumber
            value={clip.fadeOut}
            min={0}
            max={clip.duration}
            step={0.05}
            precision={2}
            suffix="s"
            onChange={(v) => update({ fadeOut: v })}
            onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} fadeOut=${clip.fadeOut}`)}
          />
        </div>
      </div>

      {!isAudioAsset && <TransitionSection clip={clip} isText={isText} onUpdate={update} />}

      {!isAudioAsset && <EffectsSection clip={clip} onUpdate={update} />}

      {!isText && !isAudioAsset && asset && <MosaicSection clip={clip} />}

      {isText && clip.text && <TextSection clip={clip} text={clip.text} onUpdate={update} />}
    </div>
  );
}

/** トランジション(イン)セクション(DESIGN.md §14.1)。video/image/テキストクリップ選択時のみ表示される。 */
function TransitionSection({
  clip,
  isText,
  onUpdate,
}: {
  clip: Clip;
  isText: boolean;
  onUpdate: (partial: Partial<Clip>) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const current = clip.transitionIn;
  const allowedTypes = isText ? (["dissolve"] as TransitionType[]) : TRANSITION_TYPES;

  function setType(value: string): void {
    if (value === "none") {
      onUpdate({ transitionIn: null });
      log.info("ui", `プロパティ変更: clipId=${clip.id} transitionIn=none`);
      return;
    }
    const type = value as TransitionType;
    const duration = clampTransitionDuration(current?.duration ?? 1, clip.duration);
    onUpdate({ transitionIn: { type, duration } });
    log.info("ui", `プロパティ変更: clipId=${clip.id} transitionIn.type=${type} duration=${duration.toFixed(2)}`);
  }

  function setDuration(v: number): void {
    if (!current) return;
    onUpdate({ transitionIn: { ...current, duration: clampTransitionDuration(v, clip.duration) } });
  }

  return (
    <div className="properties-section">
      <h3 className="properties-section-title">{t("properties.transitionIn")}</h3>
      <div className="properties-row">
        <label>{t("properties.transitionType")}</label>
        <select value={current?.type ?? "none"} onChange={(e) => setType(e.target.value)}>
          <option value="none">{t("common.none")}</option>
          {allowedTypes.map((type) => (
            <option key={type} value={type}>
              {t(`properties.transitionType.${type}`)}
            </option>
          ))}
        </select>
      </div>
      {current && (
        <div className="properties-row">
          <label>{t("properties.transitionDuration")}</label>
          <DragNumber
            value={current.duration}
            min={0.1}
            max={Math.min(3, clip.duration)}
            step={0.05}
            precision={2}
            suffix="s"
            onChange={setDuration}
            onCommit={(v) =>
              log.info("ui", `プロパティ変更: clipId=${clip.id} transitionIn.duration=${v.toFixed(2)}`)
            }
          />
        </div>
      )}
    </div>
  );
}

/** モザイクセクション(DESIGN.md §13.2)。video/image クリップ選択時のみ表示される。 */
function MosaicSection({ clip }: { clip: Clip }): JSX.Element {
  const { t } = useTranslation();
  const fps = useProjectStore((s) => s.project.settings.fps);
  const mosaicEditMode = useUIStore((s) => s.mosaicEditMode);
  const selectedRegionId = useUIStore((s) => s.selectedMosaicRegionId);

  const selectedRegion = clip.mosaics.find((r) => r.id === selectedRegionId) ?? null;

  function currentLocalTime(): number {
    const playhead = useUIStore.getState().playhead;
    return Math.min(Math.max(playhead - clip.start, 0), clip.duration);
  }

  function addRegion(): void {
    const newId = useProjectStore.getState().addMosaicRegion(clip.id, currentLocalTime());
    if (newId) useUIStore.getState().setSelectedMosaicRegionId(newId);
  }

  function removeRegion(regionId: string): void {
    useProjectStore.getState().removeMosaicRegion(clip.id, regionId);
    if (selectedRegionId === regionId) useUIStore.getState().setSelectedMosaicRegionId(null);
  }

  function seekToKeyframe(time: number): void {
    useUIStore.getState().setPlayhead(clip.start + Math.max(0, time));
    log.info("ui", `モザイクキーフレームへシーク: clipId=${clip.id} time=${time.toFixed(3)}`);
  }

  function toggleEditMode(): void {
    const next = !mosaicEditMode;
    useUIStore.getState().setMosaicEditMode(next);
    log.info("ui", `モザイク編集モード: ${next ? "開始" : "終了"} clipId=${clip.id}`);
  }

  return (
    <div className="properties-section">
      <h3 className="properties-section-title">{t("properties.mosaic")}</h3>

      {clip.mosaics.length === 0 && <div className="text-sub">{t("properties.mosaicNoRegions")}</div>}

      {clip.mosaics.map((region, index) => (
        <div
          key={region.id}
          className={`mosaic-region-item ${region.id === selectedRegionId ? "mosaic-region-item-selected" : ""}`}
          onClick={() => useUIStore.getState().setSelectedMosaicRegionId(region.id)}
        >
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>{t("properties.mosaicRegion", { index: index + 1 })}</span>
            <button
              className="btn btn-icon"
              title={t("properties.mosaicRemoveRegion")}
              onClick={(e) => {
                e.stopPropagation();
                removeRegion(region.id);
              }}
            >
              ×
            </button>
          </div>
          <label className="row properties-checkbox" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={region.enabled}
              onChange={(e) =>
                useProjectStore.getState().setMosaicRegionProps(clip.id, region.id, { enabled: e.target.checked })
              }
            />
            {t("properties.mosaicEnabled")}
          </label>
          <div className="properties-row">
            <label>{t("properties.mosaicBlockSize")}</label>
            <input
              type="range"
              min={MOSAIC_BLOCK_SIZE_MIN}
              max={MOSAIC_BLOCK_SIZE_MAX}
              step={1}
              value={region.blockSize}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                useProjectStore
                  .getState()
                  .setMosaicRegionProps(clip.id, region.id, { blockSize: Number(e.target.value) })
              }
            />
            <span className="mosaic-blocksize-value">{region.blockSize}</span>
          </div>
        </div>
      ))}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={addRegion}>
          + {t("properties.mosaicAddRegion")}
        </button>
        <button className={`btn ${mosaicEditMode ? "btn-active" : ""}`} onClick={toggleEditMode}>
          {t("properties.mosaicEditInPreview")}
        </button>
      </div>

      {mosaicEditMode && <div className="text-sub mosaic-shortcut-hint">{t("properties.mosaicShortcutHint")}</div>}

      {selectedRegion && (
        <>
          <h3 className="properties-section-title">{t("properties.mosaicKeyframes")}</h3>
          <ul className="mosaic-kf-list">
            {selectedRegion.keyframes.map((kf, i) => (
              <li key={i} className="row mosaic-kf-item">
                <button className="mosaic-kf-time" onClick={() => seekToKeyframe(kf.time)}>
                  {formatTimecode(Math.max(0, kf.time), fps)}
                </button>
                <button
                  className="btn btn-icon"
                  title={t("properties.mosaicRemoveKeyframe")}
                  disabled={selectedRegion.keyframes.length <= 1}
                  onClick={() => useProjectStore.getState().removeMosaicKeyframe(clip.id, selectedRegion.id, i)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={() => recordMosaicKeyframeAtPlayhead()}>
            {t("properties.mosaicAddKeyframe")}
          </button>
        </>
      )}
    </div>
  );
}

function EffectsSection({
  clip,
  onUpdate,
}: {
  clip: Clip;
  onUpdate: (partial: Partial<Clip>) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const hasEq = clip.effects.some((e) => e.type === "eq");
  const hasBlur = clip.effects.some((e) => e.type === "blur");

  function addEffect(effect: Effect): void {
    onUpdate({ effects: [...clip.effects, effect] });
    log.info("ui", `エフェクト追加: clipId=${clip.id} type=${effect.type}`);
  }

  function removeEffect(index: number): void {
    const removed = clip.effects[index];
    onUpdate({ effects: clip.effects.filter((_, i) => i !== index) });
    log.info("ui", `エフェクト削除: clipId=${clip.id} type=${removed?.type}`);
  }

  function updateEffect(index: number, partial: Record<string, number>): void {
    onUpdate({
      effects: clip.effects.map((e, i) => (i === index ? ({ ...e, ...partial } as unknown as Effect) : e)),
    });
  }

  return (
    <div className="properties-section">
      <h3 className="properties-section-title">{t("properties.effects")}</h3>
      {clip.effects.map((effect, index) => (
        <div className="effect-item" key={index}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>{effect.type === "eq" ? t("properties.effectEq") : t("properties.effectBlur")}</span>
            <button className="btn btn-icon" title={t("properties.removeEffect")} onClick={() => removeEffect(index)}>
              ×
            </button>
          </div>
          {effect.type === "eq" && (
            <>
              <div className="properties-row">
                <label>{t("properties.brightness")}</label>
                <DragNumber
                  value={effect.brightness}
                  min={-1}
                  max={1}
                  step={0.01}
                  precision={2}
                  onChange={(v) => updateEffect(index, { brightness: v })}
                  onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} eq.brightness`)}
                />
              </div>
              <div className="properties-row">
                <label>{t("properties.contrast")}</label>
                <DragNumber
                  value={effect.contrast}
                  min={0}
                  max={2}
                  step={0.01}
                  precision={2}
                  onChange={(v) => updateEffect(index, { contrast: v })}
                  onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} eq.contrast`)}
                />
              </div>
              <div className="properties-row">
                <label>{t("properties.saturation")}</label>
                <DragNumber
                  value={effect.saturation}
                  min={0}
                  max={3}
                  step={0.01}
                  precision={2}
                  onChange={(v) => updateEffect(index, { saturation: v })}
                  onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} eq.saturation`)}
                />
              </div>
            </>
          )}
          {effect.type === "blur" && (
            <div className="properties-row">
              <label>{t("properties.blurRadius")}</label>
              <DragNumber
                value={effect.radius}
                min={0}
                max={50}
                step={0.5}
                precision={1}
                onChange={(v) => updateEffect(index, { radius: v })}
                onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} blur.radius`)}
              />
            </div>
          )}
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button
          className="btn"
          disabled={hasEq}
          onClick={() => addEffect({ type: "eq", brightness: 0, contrast: 1, saturation: 1 })}
        >
          + {t("properties.effectEq")}
        </button>
        <button className="btn" disabled={hasBlur} onClick={() => addEffect({ type: "blur", radius: 0 })}>
          + {t("properties.effectBlur")}
        </button>
      </div>
    </div>
  );
}

function TextSection({
  clip,
  text,
  onUpdate,
}: {
  clip: Clip;
  text: NonNullable<Clip["text"]>;
  onUpdate: (partial: Partial<Clip>) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const fonts = useSystemFonts();

  function updateText(partial: Partial<NonNullable<Clip["text"]>>): void {
    onUpdate({ text: { ...text, ...partial } });
  }

  function updateTextAndLog(partial: Partial<NonNullable<Clip["text"]>>, label: string): void {
    updateText(partial);
    log.info("ui", `プロパティ変更: clipId=${clip.id} ${label}`);
  }

  return (
    <div className="properties-section">
      <h3 className="properties-section-title">{t("properties.clipText")}</h3>
      <div className="col" style={{ gap: 4 }}>
        <label>{t("properties.textContent")}</label>
        <textarea
          rows={3}
          value={text.content}
          onChange={(e) => updateText({ content: e.target.value })}
          onBlur={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.content`)}
        />
      </div>
      <div className="properties-row">
        <label>{t("properties.textFont")}</label>
        <input
          list="system-fonts"
          value={text.fontFamily}
          onChange={(e) => updateText({ fontFamily: e.target.value })}
          onBlur={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.fontFamily=${text.fontFamily}`)}
        />
        <datalist id="system-fonts">
          {fonts.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>
      <div className="properties-row">
        <label>{t("properties.textSize")}</label>
        <DragNumber
          value={text.fontSize}
          min={4}
          max={512}
          step={1}
          precision={0}
          onChange={(v) => updateText({ fontSize: v })}
          onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.fontSize=${text.fontSize}`)}
        />
      </div>
      <div className="properties-row">
        <label>{t("properties.textColor")}</label>
        <input
          type="color"
          value={text.color}
          onChange={(e) => updateTextAndLog({ color: e.target.value }, `text.color=${e.target.value}`)}
        />
      </div>
      <label className="row properties-checkbox">
        <input
          type="checkbox"
          checked={text.bold}
          onChange={(e) => updateTextAndLog({ bold: e.target.checked }, `text.bold=${e.target.checked}`)}
        />
        {t("properties.textBold")}
      </label>
      <div className="properties-row">
        <label>{t("properties.textAlign")}</label>
        <div className="row" style={{ gap: 4 }}>
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              className={`btn ${text.align === align ? "btn-active" : ""}`}
              onClick={() => updateTextAndLog({ align }, `text.align=${align}`)}
            >
              {t(`properties.textAlign${align.charAt(0).toUpperCase()}${align.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="properties-row">
        <label>{t("properties.textBackground")}</label>
        <input
          type="color"
          value={text.background ?? "#000000"}
          onChange={(e) => updateTextAndLog({ background: e.target.value }, `text.background=${e.target.value}`)}
        />
        <button
          className="btn"
          disabled={text.background === null}
          onClick={() => updateTextAndLog({ background: null }, "text.background=none")}
        >
          {t("properties.textBackgroundNone")}
        </button>
      </div>

      {/* テキスト強化(DESIGN.md §14.2): 縁取り/影/行間。 */}
      <div className="properties-row">
        <label>{t("properties.textOutline")}</label>
        <input
          type="color"
          value={text.outlineColor ?? "#000000"}
          onChange={(e) =>
            updateTextAndLog(
              { outlineColor: e.target.value, outlineWidth: text.outlineWidth > 0 ? text.outlineWidth : 4 },
              `text.outlineColor=${e.target.value}`,
            )
          }
        />
        <DragNumber
          value={text.outlineWidth}
          min={0}
          max={20}
          step={0.5}
          precision={1}
          suffix="px"
          disabled={text.outlineColor === null}
          onChange={(v) => updateText({ outlineWidth: v })}
          onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.outlineWidth=${text.outlineWidth}`)}
        />
        <button
          className="btn"
          disabled={text.outlineColor === null}
          onClick={() => updateTextAndLog({ outlineColor: null, outlineWidth: 0 }, "text.outline=none")}
        >
          {t("properties.textOutlineNone")}
        </button>
      </div>
      <div className="properties-row">
        <label>{t("properties.textShadow")}</label>
        <input
          type="color"
          value={text.shadowColor ?? "#000000"}
          onChange={(e) => updateTextAndLog({ shadowColor: e.target.value }, `text.shadowColor=${e.target.value}`)}
        />
        <button
          className="btn"
          disabled={text.shadowColor === null}
          onClick={() => updateTextAndLog({ shadowColor: null }, "text.shadow=none")}
        >
          {t("properties.textShadowNone")}
        </button>
      </div>
      <div className="properties-row">
        <label>{t("properties.textShadowX")}</label>
        <DragNumber
          value={text.shadowX}
          min={-50}
          max={50}
          step={0.5}
          precision={1}
          onChange={(v) => updateText({ shadowX: v })}
          onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.shadowX=${text.shadowX}`)}
        />
        <label>{t("properties.textShadowY")}</label>
        <DragNumber
          value={text.shadowY}
          min={-50}
          max={50}
          step={0.5}
          precision={1}
          onChange={(v) => updateText({ shadowY: v })}
          onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.shadowY=${text.shadowY}`)}
        />
      </div>
      <div className="properties-row">
        <label>{t("properties.textLineSpacing")}</label>
        <DragNumber
          value={text.lineSpacing}
          min={0}
          max={100}
          step={1}
          precision={0}
          suffix="px"
          onChange={(v) => updateText({ lineSpacing: v })}
          onCommit={() => log.info("ui", `プロパティ変更: clipId=${clip.id} text.lineSpacing=${text.lineSpacing}`)}
        />
      </div>
    </div>
  );
}
