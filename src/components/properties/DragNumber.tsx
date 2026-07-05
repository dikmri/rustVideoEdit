// ドラッグで増減、クリックで直接入力できる数値コンポーネント(DESIGN.md §9 Properties)。
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface DragNumberProps {
  value: number;
  onChange: (value: number) => void;
  /** ドラッグ終了時/直接入力確定時に一度だけ呼ばれる(ログ記録用)。 */
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  /** 1px ドラッグあたりの増減量。既定 1。 */
  step?: number;
  /** 表示桁数。既定 2。 */
  precision?: number;
  suffix?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

const DRAG_THRESHOLD_PX = 3;

function clamp(v: number, min?: number, max?: number): number {
  let r = v;
  if (min !== undefined) r = Math.max(min, r);
  if (max !== undefined) r = Math.min(max, r);
  return r;
}

export function DragNumber(props: DragNumberProps): JSX.Element {
  const {
    value,
    onChange,
    onCommit,
    min,
    max,
    step = 1,
    precision = 2,
    suffix = "",
    disabled = false,
  } = props;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const dragState = useRef<{ startX: number; startValue: number; lastValue: number; dragging: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (disabled || editing) return;
    e.preventDefault();
    dragState.current = { startX: e.clientX, startValue: value, lastValue: value, dragging: false };

    const handleMove = (ev: PointerEvent): void => {
      const st = dragState.current;
      if (!st) return;
      const dx = ev.clientX - st.startX;
      if (!st.dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      st.dragging = true;
      const next = clamp(st.startValue + dx * step, min, max);
      st.lastValue = next;
      onChange(next);
    };

    const handleUp = (): void => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      const st = dragState.current;
      dragState.current = null;
      if (st?.dragging) {
        onCommit?.(st.lastValue);
      } else {
        setDraft(value.toFixed(precision));
        setEditing(true);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function commitDraft(): void {
    // Enter 確定 → 入力欄アンマウント時のネイティブ blur による二重発火を防ぐ。
    if (!editing) return;
    const parsed = Number.parseFloat(draft);
    setEditing(false);
    if (Number.isNaN(parsed)) return;
    const next = clamp(parsed, min, max);
    onChange(next);
    onCommit?.(next);
  }

  if (editing) {
    return (
      <div className="drag-number">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitDraft();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="drag-number"
      onPointerDown={handlePointerDown}
      aria-label={props["aria-label"]}
      role="spinbutton"
      aria-valuenow={value}
      aria-disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: "default" } : undefined}
    >
      <span>
        {value.toFixed(precision)}
        {suffix}
      </span>
    </div>
  );
}
