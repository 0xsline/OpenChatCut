// Shared drag payload between resource library cards and the timeline.
// MIME is private so OS file drops still work on other surfaces.
import { t } from '../i18n/locale';
import { setEditorDrag } from '../editor/editorDrag';

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
  /** Application data of plugin entries (zoom envelope/transition frag/MG template), self-contained parsing on the drop side,
   * No need to check the plugin library. The receiving end verifies the shape before use (drag-and-drop JSON is regarded as untrusted input). */
  data?: unknown;
}

export function setLibraryDrag(
  e: React.DragEvent,
  payload: Omit<LibraryDragPayload, 'v'>,
): void {
  const full: LibraryDragPayload = { v: 1, ...payload };
  const json = JSON.stringify(full);
  setEditorDrag(e, {
    source: 'library',
    id: payload.id,
    name: payload.name,
    resourceKind: payload.kind,
  });
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
