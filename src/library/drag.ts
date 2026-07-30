// Shared drag payload between resource library cards and the timeline.
// MIME is private so OS file drops still work on other surfaces.
import { t } from '../i18n/locale';

export const LIBRARY_DRAG_MIME = 'application/x-openchatcut-library';

export type LibraryDragKind =
  | 'transition'
  | 'fx'
  | 'lut'
  | 'zoom'
  | 'sound'
  | 'template'
  | 'audio-fx';

export interface LibraryDragPayload {
  v: 1;
  kind: LibraryDragKind;
  id: string;
  name: string;
  /** sound: public src path */
  src?: string;
  /** sound: duration in seconds */
  seconds?: number;
  /** 插件条目的应用数据(缩放包络/转场 frag/MG 模板),drop 端自包含解析,
   * 不必反查插件库。接收端按形状校验后再用(拖拽 JSON 视为不可信输入)。 */
  data?: unknown;
}

export function setLibraryDrag(
  e: React.DragEvent,
  payload: Omit<LibraryDragPayload, 'v'>,
): void {
  const full: LibraryDragPayload = { v: 1, ...payload };
  const json = JSON.stringify(full);
  e.dataTransfer.setData(LIBRARY_DRAG_MIME, json);
  // Fallback for environments that strip custom MIME types
  e.dataTransfer.setData('text/plain', json);
  e.dataTransfer.effectAllowed = 'copy';
}

export function parseLibraryDrag(e: React.DragEvent): LibraryDragPayload | null {
  const raw =
    e.dataTransfer.getData(LIBRARY_DRAG_MIME)
    || e.dataTransfer.getData('text/plain');
  if (!raw || raw[0] !== '{') return null;
  try {
    const p = JSON.parse(raw) as LibraryDragPayload;
    if (p?.v !== 1 || !p.kind || !p.id) return null;
    return p;
  } catch {
    return null;
  }
}

export function hasLibraryDrag(e: React.DragEvent): boolean {
  const types = Array.from(e.dataTransfer.types ?? []);
  // Prefer our private MIME; some browsers only expose text/plain during dragover
  return types.includes(LIBRARY_DRAG_MIME) || types.includes('text/plain');
}

/** true when drop payload is ours (not a random text/file drag) */
export function isLibraryPayload(p: LibraryDragPayload | null): p is LibraryDragPayload {
  return !!p && p.v === 1 && typeof p.kind === 'string' && typeof p.id === 'string';
}

/** Human label for drop-target highlight / toast title */
export function libraryDragLabel(kind: LibraryDragKind): string {
  switch (kind) {
    case 'transition': return t('转场');
    case 'fx': return t('特效');
    case 'lut': return 'LUT';
    case 'zoom': return t('缩放');
    case 'sound': return t('音效');
    case 'template': return 'MG';
    case 'audio-fx': return t('音频效果');
  }
}
