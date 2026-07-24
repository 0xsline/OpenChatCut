// Monochrome line icons (lucide-style, 24×24 stroke) for the editor
// toolbar/track-header glyphs — replaces emoji for a consistent editor chrome.

export type IconName =
  | 'plus' | 'cursor' | 'trim' | 'rateStretch' | 'blade' | 'scissors' | 'magnet' | 'mic' | 'chevronDown' | 'check' | 'brush' | 'cloud' | 'insert'
  | 'play' | 'pause' | 'text' | 'copy' | 'trash' | 'bookmark' | 'prev' | 'next'
  | 'zoomOut' | 'zoomIn' | 'fit' | 'aspect' | 'captions' | 'fullscreen'
  | 'eye' | 'eyeOff' | 'volume' | 'volumeOff' | 'lock' | 'unlock'
  | 'home' | 'sparkles' | 'sliders' | 'bookOpen' | 'thumbUp' | 'thumbDown' | 'arrowUp'
  | 'paperclip' | 'cornerDownLeft' | 'filePlay' | 'fileHeadphone' | 'clock'
  | 'undo' | 'redo' | 'history' | 'layoutPanel' | 'keyboard' | 'users'
  | 'download' | 'film' | 'clipboard'
  | 'music' | 'video' | 'image' | 'swap' | 'star' | 'pencil' | 'x' | 'diamond'
  | 'search' | 'upload' | 'folder' | 'folderPlus' | 'grid' | 'list' | 'sort' | 'filter' | 'more' | 'bug'
  | 'palette' | 'wand' | 'tracking' | 'qrCode';

// stroke path(s) per icon; a few are fill-based (play/pause/cursor/bookmark)
const FILL = new Set<IconName>(['play', 'pause', 'cursor', 'bookmark']);

const P: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  // lucide wand-sparkles simplified (creative mode)
  wand: 'M15 4V2 M15 16v-2 M8 9h2 M20 9h2 M17.8 11.8L19 13 M17.8 6.2L19 5 M12.2 6.2L11 5 M3 21l9-9',
  cursor: 'M5 3l6 15 2-6 6-2z',
  trim: 'M8 4v16M4 8h4M4 16h4 M16 4v16M16 8h4M16 16h4',
  rateStretch: 'M4 5v14 M20 5v14 M8 12h8 M11 9l-3 3 3 3 M13 9l3 3-3 3',
  blade: 'M14 4L6 20 M9 9l7 3',
  scissors: 'M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M8.1 8.1L20 20 M14 14l6-10',
  magnet: 'M6 15l-3-3a8 8 0 0 1 11-11l3 3-7 7-3-3 M6 15l3 3 M14 7l3 3',
  tracking: 'M8 3H5a2 2 0 0 0-2 2v3 M16 3h3a2 2 0 0 1 2 2v3 M3 16v3a2 2 0 0 0 2 2h3 M21 16v3a2 2 0 0 1-2 2h-3 M12 8m-4 4a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
  mic: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M5 10a7 7 0 0 0 14 0 M12 19v3',
  insert: 'M5 5v14 M19 5v14 M12 8v8 M9 12h6',
  chevronDown: 'M6 9l6 6 6-6',
  check: 'M20 6L9 17l-5-5',
  cloud: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  brush: 'M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08 M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-.5 2.52-2 3.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z',
  play: 'M7 4l13 8-13 8z',
  pause: 'M7 4h4v16H7z M15 4h4v16h-4z',
  text: 'M5 6h14M12 6v13',
  copy: 'M9 9h11v11H9z M4 15V4h11',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  bookmark: 'M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  prev: 'M15 5l-7 7 7 7M8 5v14',
  next: 'M9 5l7 7-7 7M16 5v14',
  zoomOut: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M21 21l-4.3-4.3 M8 11h6',
  zoomIn: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M21 21l-4.3-4.3 M11 8v6M8 11h6',
  // Adapt view: horizontal double arrow ↔ (not four corners maximize)
  fit: 'M3 12h18 M7 8l-4 4 4 4 M17 8l4 4-4 4',
  // Aspect ratio: "proportions" style - small frame embedded in outer frame
  aspect: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M7 9h6v4H7z',
  // Subtitles: Rounded CC logo (two open Cs facing right)
  captions: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M11 10a2.4 2.4 0 1 0 0 4 M18 10a2.4 2.4 0 1 0 0 4',
  fullscreen: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  eyeOff: 'M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.4 M6.6 6.6A13 13 0 0 0 2 12s3.5 7 10 7a9 9 0 0 0 3.4-.66 M3 3l18 18',
  volume: 'M11 5L6 9H2v6h4l5 4z M16 8a5 5 0 0 1 0 8',
  volumeOff: 'M11 5L6 9H2v6h4l5 4z M22 9l-6 6 M16 9l6 6',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.9-1',
  home: 'M3 10.5L12 3l9 7.5 M5 9.5V21h5v-6h4v6h5V9.5',
  // composer/message glyphs — verbatim lucide paths
  sparkles: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z',
  sliders: 'M10 5H3 M12 19H3 M14 3v4 M16 17v4 M21 12h-9 M21 19h-5 M21 5h-7 M8 10v4 M8 12H3',
  bookOpen: 'M12 7v14 M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  thumbUp: 'M7 10v12 M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
  thumbDown: 'M17 14V2 M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
  arrowUp: 'm5 12 7-7 7 7 M12 19V5',
  paperclip: 'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551',
  cornerDownLeft: 'M20 4v7a4 4 0 0 1-4 4H4 m9 10-5 5 5 5',
  filePlay: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z M14 2v5a1 1 0 0 0 1 1h5 M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z',
  fileHeadphone: 'M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343 M14 2v5a1 1 0 0 0 1 1h5 M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0',
  clock: 'M12 12m-10 0a10 10 0 1 0 20 0a10 10 0 1 0-20 0 M12 6v6l4 2',
  // Top-bar glyphs based on Lucide shapes.
  undo: 'M9 14 4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11',
  redo: 'm15 14 5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  history: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8 M3 3v5h5 M12 7v5l4 2',
  layoutPanel: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M15 3v18',
  keyboard: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M6 14h.01 M10 14h8',
  // `users` uses a path-only shape so the single-<path> Icon can render it.
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3.128a4 4 0 0 1 0 7.744 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  film: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7 3v18 M17 3v18 M3 8h4 M3 16h4 M17 8h4 M17 16h4 M3 12h18',
  clipboard: 'M9 2h6a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2',
  music: 'M9 18V5l12-2v13 M9 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M21 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  video: 'm16 10 4.4-2.65A1 1 0 0 1 22 8.2v7.6a1 1 0 0 1-1.6.85L16 14 M14 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
  image: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8.5 8.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M21 15l-5-5L5 21',
  swap: 'M8 3 4 7l4 4 M4 7h16 M16 21l4-4-4-4 M20 17H4',
  star: 'M11.5 2.6a.5.5 0 0 1 1 0l2.5 5.1 5.6.8a.5.5 0 0 1 .3.85l-4 3.9 1 5.6a.5.5 0 0 1-.75.53L12 16.7l-5 2.63a.5.5 0 0 1-.73-.53l1-5.6-4.1-3.9a.5.5 0 0 1 .3-.85l5.6-.8z',
  pencil: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  x: 'M18 6 6 18 M6 6l12 12',
  diamond: 'M12 2 22 12 12 22 2 12z',
  search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M21 21l-4.3-4.3',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5',
  qrCode: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h3v3h-3z M18 14h3 M21 17v4h-4 M14 21h3 M6 6h1 M17 6h1 M6 17h1',
  folder: 'M3 6h7l2 2h9v11H3z',
  folderPlus: 'M3 6h7l2 2h9v11H3z M12 11v5 M9.5 13.5h5',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  sort: 'M8 5v14 M5 8l3-3 3 3 M16 19V5 M13 16l3 3 3-3',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  bug: 'M8 2l1.5 2h5L16 2 M9 9h6v7a3 3 0 0 1-6 0z M5 9h4 M15 9h4 M4 13h5 M15 13h5 M5 18h4 M15 18h4 M12 9v10',
  // Lucide-style `palette` outline with four paint dots drawn as tiny arcs.
  palette: 'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z M7.5 12.5m-.6 0a.6 .6 0 1 0 1.2 0a.6 .6 0 1 0-1.2 0 M8.5 7.5m-.6 0a.6 .6 0 1 0 1.2 0a.6 .6 0 1 0-1.2 0 M13.5 6.5m-.6 0a.6 .6 0 1 0 1.2 0a.6 .6 0 1 0-1.2 0 M17.5 10.5m-.6 0a.6 .6 0 1 0 1.2 0a.6 .6 0 1 0-1.2 0',
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** render solid (e.g. a favorited star) instead of stroked */
  filled?: boolean;
}

export function Icon({ name, size = 16, color = 'currentColor', strokeWidth = 1.8, filled }: IconProps) {
  const fill = filled || FILL.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? color : 'none'}
      stroke={fill ? 'none' : color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <path d={P[name]} />
    </svg>
  );
}

/** Brand logo:speech bubble + play button(Conversational video cutting). Bubbles=accent color,play button=onAccent
 *  (Skin discipline guaranteed ≥4.5 Contrast). Where to substitute wordmark former sparkles Use this. */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <img src="/openchatcut-icon.png" alt="" aria-hidden width={size} height={size} style={{ display: 'block' }} />
  );
}

/** OpenChatCut Text mark:OPEN reverse white badge + Chat Cut Solid wordmark. */
export function OpenChatCutWordmark({ width = 126 }: { width?: number }) {
  return (
    <svg
      aria-label="OpenChatCut"
      role="img"
      width={width}
      height={width / 4}
      viewBox="0 0 504 126"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="0" y="13" width="166" height="92" rx="14" fill="currentColor" />
      <text
        fontFamily="Inter, system-ui, sans-serif"
        dominantBaseline="alphabetic"
      >
        <tspan x="83" y="82" textAnchor="middle" fill="var(--cc-panel)" fontSize="58" fontWeight="850" letterSpacing="-0.045em">
          OPEN
        </tspan>
        <tspan x="188" y="79" fill="currentColor" fontSize="62" fontWeight="720" letterSpacing="-0.045em">
          Chat Cut
        </tspan>
      </text>
    </svg>
  );
}
