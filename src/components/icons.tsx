// Monochrome line icons (lucide-style, 24×24 stroke) matching ChatCut's editor
// toolbar/track-header glyphs — replaces emoji so the chrome reads like the source.

export type IconName =
  | 'plus' | 'cursor' | 'trim' | 'blade' | 'scissors' | 'magnet' | 'mic' | 'chevronDown'
  | 'play' | 'pause' | 'text' | 'copy' | 'trash' | 'bookmark' | 'prev' | 'next'
  | 'zoomOut' | 'zoomIn' | 'fit' | 'aspect' | 'captions' | 'fullscreen'
  | 'eye' | 'eyeOff' | 'volume' | 'volumeOff' | 'lock' | 'unlock';

// stroke path(s) per icon; a few are fill-based (play/pause/cursor/bookmark)
const FILL = new Set<IconName>(['play', 'pause', 'cursor', 'bookmark']);

const P: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  cursor: 'M5 3l6 15 2-6 6-2z',
  trim: 'M8 4v16M4 8h4M4 16h4 M16 4v16M16 8h4M16 16h4',
  blade: 'M14 4L6 20 M9 9l7 3',
  scissors: 'M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M8.1 8.1L20 20 M14 14l6-10',
  magnet: 'M6 15l-3-3a8 8 0 0 1 11-11l3 3-7 7-3-3 M6 15l3 3 M14 7l3 3',
  mic: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M5 10a7 7 0 0 0 14 0 M12 19v3',
  chevronDown: 'M6 9l6 6 6-6',
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
  fit: 'M4 8V5a1 1 0 0 1 1-1h3 M20 8V5a1 1 0 0 0-1-1h-3 M4 16v3a1 1 0 0 0 1 1h3 M20 16v3a1 1 0 0 1-1 1h-3 M3 12h18M7 9l-3 3 3 3M17 9l3 3-3 3',
  aspect: 'M3 5h18v14H3z',
  captions: 'M3 5h18v14H3z M8 10a2 2 0 0 0-2 2 2 2 0 0 0 2 2 M17 10a2 2 0 0 0-2 2 2 2 0 0 0 2 2',
  fullscreen: 'M8 3H5a2 2 0 0 0-2 2v3 M21 8V5a2 2 0 0 0-2-2h-3 M3 16v3a2 2 0 0 0 2 2h3 M16 21h3a2 2 0 0 0 2-2v-3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  eyeOff: 'M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.4 M6.6 6.6A13 13 0 0 0 2 12s3.5 7 10 7a9 9 0 0 0 3.4-.66 M3 3l18 18',
  volume: 'M11 5L6 9H2v6h4l5 4z M16 8a5 5 0 0 1 0 8',
  volumeOff: 'M11 5L6 9H2v6h4l5 4z M22 9l-6 6 M16 9l6 6',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.9-1',
};

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) {
  const fill = FILL.has(name);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? color : 'none'}
      stroke={fill ? 'none' : color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }} aria-hidden>
      <path d={P[name]} />
    </svg>
  );
}
