import type { TimelineItem } from '../editor/types';
import type { FxClip } from '../components/timeline/ClipContextMenu';
import type { EditMode } from '../components/timeline/timelineUtil';

/** Methods Timeline exposes so Editor can bind the global shortcut dispatcher. */
export interface TimelineShortcutApi {
  getPlayhead: () => number;
  seekTo: (frame: number) => void;
  playPause: () => void;
  isPlaying: () => boolean;
  setEditMode: (m: EditMode) => void;
  toggleSnap: () => void;
  fitToView: () => void;
  zoomBy: (factor: number) => void;
  splitAtPlayhead: () => void;
  nudgeSelected: (deltaFrames: number) => void;
  trimSelectedToPlayhead: (side: 'start' | 'end') => void;
  selectAfterPlayhead: () => void;
  selectUnderPlayhead: () => void;
  gotoEdit: (dir: 1 | -1) => void;
  gotoMarker: (dir: 1 | -1) => void;
  addMarker: (open: boolean) => void;
  modifyMarkerAtPlayhead: () => void;
  deleteMarkerAtPlayhead: () => void;
  setZoneIn: () => void;
  setZoneOut: () => void;
  clearZone: () => void;
  zoneFromClip: () => void;
  zoneFromSelection: () => void;
  getZone: () => { inFrame: number | null; outFrame: number | null };
  shuttle: (dir: -1 | 0 | 1) => void;
  shuttleJog: (dir: -1 | 1) => void;
  moveSelectedTrack: (dir: -1 | 1) => void;
  moveSelectedToBoundary: (side: 'left' | 'right') => void;
  copySelected: () => void;
  cutSelected: () => void;
  pasteClipboard: () => void;
  pasteEffects: () => void;
  copyEffects: () => void;
  duplicateSelected: () => void;
  deleteSelected: (ripple: boolean) => void;
  fullscreenPreview: () => void;
  /** Last copied effects (for menu parity). */
  getFxClip: () => FxClip | null;
  setFxClip: (fx: FxClip | null) => void;
}

export type ItemClipboard =
  | { kind: 'item'; item: TimelineItem; /** multi-copy payload (optional) */ multi?: TimelineItem[] }
  | null;
