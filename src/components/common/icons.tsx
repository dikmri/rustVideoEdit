// インライン SVG アイコン集(DESIGN.md §9: アイコンはインライン SVG、絵文字禁止)。
// stroke 1.5px、currentColor に統一。
import type { ReactNode } from "react";

export interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconNew(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M12 12v6M9 15h6" />
    </Svg>
  );
}

export function IconOpen(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
    </Svg>
  );
}

export function IconSave(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 3h11l3 3v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M8 3v6h8V3M8 21v-7h8v7" />
    </Svg>
  );
}

export function IconExport(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </Svg>
  );
}

export function IconGlobe(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </Svg>
  );
}

export function IconSettings(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3H9.8l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" />
    </Svg>
  );
}

export function IconInfo(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v.01" />
    </Svg>
  );
}

export function IconWarning(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v5M12 18v.01" />
    </Svg>
  );
}

export function IconPlay(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 4l14 8-14 8Z" />
    </Svg>
  );
}

export function IconPause(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 4h3v16H7zM14 4h3v16h-3z" />
    </Svg>
  );
}

export function IconToStart(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 4v16" />
      <path d="M19 5 9 12l10 7Z" />
    </Svg>
  );
}

export function IconToEnd(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M18 4v16" />
      <path d="M5 5l10 7-10 7Z" />
    </Svg>
  );
}

export function IconPrevFrame(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 5v14" />
      <path d="M19 6v12l-8-6Z" />
    </Svg>
  );
}

export function IconNextFrame(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M15 5v14" />
      <path d="M5 6v12l8-6Z" />
    </Svg>
  );
}

export function IconTrash(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function IconPlus(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconMusic(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </Svg>
  );
}

export function IconSpinner(props: IconProps): JSX.Element {
  return (
    <Svg {...props} className={`icon-spin ${props.className ?? ""}`}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Svg>
  );
}

export function IconCursorArrow(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 3 19 10 12 12 10 19 5 3Z" />
    </Svg>
  );
}

export function IconScissors(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <path d="M8 8l12 12M8 16 20 4" />
    </Svg>
  );
}

export function IconRippleDelete(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 10l-3 1.5L5 13" />
      <path d="M10 8h9M11 5h6" />
      <path d="M9 8l1 12h8l1-12" />
    </Svg>
  );
}

export function IconSnap(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 3v8a6 6 0 0 0 12 0V3" />
      <path d="M6 3h4M14 3h4" />
      <path d="M6 7h4M14 7h4" />
    </Svg>
  );
}

export function IconTextT(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 5h14M12 5v14" />
    </Svg>
  );
}

export function IconFitScreen(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  );
}

export function IconLock(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function IconUnlock(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="5" y="11" width="14" height="9" rx="1" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2" />
    </Svg>
  );
}

export function IconSpeakerOn(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 9v6h4l5 5V4L8 9H4Z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10" />
    </Svg>
  );
}

export function IconSpeakerOff(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 9v6h4l5 5V4L8 9H4Z" />
      <path d="M16 10l5 5M21 10l-5 5" />
    </Svg>
  );
}
