// 时间线共享基座:布局常量、时间码/标尺格式化、拖拽类型、音频波形。
// Timeline 主件与拆出的子件(Toolbar/Ruler/TrackLane/useTimelinePointer)都从这里取,
// 保证几何与文案只有一份真源。全部逐字搬自 Timeline.tsx 顶部。
import { theme } from '../../theme';
import type { TimelineItem, TrackId } from '../../editor/types';

/** sticky track-head: pad 16 + badge+7 icons@20 + 7×gap4 ≈ 200 */
export const HEADER_W = 212;
export const MIN_ROW = 34;
export const RULER_H = 28;
/** Equal-height tracks without per-row duck controls. */
export const TRACK_ROW = 56;
export const MAX_ROW = 72;
// Clip fill by item kind: video/image=blue, audio=green,
// motion-graphic=pink, text=amber). Video/image also render a media thumbnail on top.
export const CLIP_COLOR: Record<TimelineItem['kind'], string> = {
  video: theme.clipVideo, image: theme.clipVideo, gif: theme.clipVideo, svg: theme.clipVideo,
  solid: '#4a5568',
  audio: theme.clipAudio,
  'motion-graphic': theme.clipMg, text: theme.clipText,
};
/** default time scale — 1s ≈ 36px @30fps (shorter clips, less “巨型色块”) */
export const PX_PER_FRAME = 1.2;
export const MIN_TIME_ZOOM = 0.02; // long timelines (3–8 min) must still fit in one viewport
/** Target minimum pixels between major ruler labels. */
export const RULER_LABEL_MIN_PX = 52;

export function fmt(frames: number, fps: number): string {
  const s = frames / fps;
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function fmtClock(frames: number, fps: number): string {
  const seconds = Math.floor(frames / fps);
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** pick major tick step (seconds) so labels stay readable at current zoom */
export function rulerMajorSeconds(pxPerFrame: number, fps: number): number {
  // finer steps so zoomed-in timelines get sub-second / few-second marks
  const options = [0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of options) {
    if (s * fps * pxPerFrame >= RULER_LABEL_MIN_PX) return s;
  }
  return 600;
}

/** number of minor ticks between majors (more when majors are far apart) */
export function rulerMinorCount(majorSec: number): number {
  if (majorSec <= 0.5) return 1;
  if (majorSec <= 2) return 3;
  if (majorSec <= 10) return 4;
  if (majorSec <= 30) return 5;
  return 9;
}

export function fmtRuler(frames: number, fps: number): string {
  const s = frames / fps;
  if (s < 60) {
    const ss = Math.floor(s);
    const cs = Math.floor((s * 100) % 100);
    return `${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

export type DragMode = 'move' | 'trim-left' | 'trim-right';
export interface Drag {
  id: string; mode: DragMode; baseStart: number; baseDur: number; baseTrack: TrackId;
  baseSrcIn: number; startX: number; deltaF: number; targetTrack: TrackId; snapAt: number | null;
}
// how close (px) an edge must come to a snap target before it locks on
export const SNAP_PX = 7;

// Paint dense, filled audio peaks instead of a repeated decorative zig-zag.
// Generate a stable waveform from clip identity so the
// same project keeps the same visual shape without decoding audio in React.
export function waveformPath(seed: string, width: number): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  const count = Math.min(1200, Math.max(24, Math.ceil(width / 2)));
  const bars: string[] = [];
  for (let i = 0; i < count; i += 1) {
    hash ^= hash << 13; hash ^= hash >>> 17; hash ^= hash << 5;
    const envelope = 0.55 + 0.45 * Math.sin((i / (count - 1)) * Math.PI);
    const amplitude = 2.5 + ((hash >>> 0) % 850) / 100 * envelope;
    const x = (i / (count - 1)) * width;
    bars.push(`M${x.toFixed(2)} ${(12 - amplitude).toFixed(2)}V${(12 + amplitude).toFixed(2)}`);
  }
  return bars.join(' ');
}
