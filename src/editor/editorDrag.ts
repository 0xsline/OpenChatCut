import type { LibraryDragKind } from '../library/drag';
import type { MediaAssetKind } from './types';

export const EDITOR_DRAG_MIME = 'application/x-openchatcut-editor-item';

const MEDIA_KINDS = new Set<MediaAssetKind>([
  'video', 'image', 'audio', 'motion-graphic', 'gif', 'svg',
]);

const LIBRARY_KINDS = new Set<LibraryDragKind>([
  'transition', 'fx', 'lut', 'zoom', 'sound', 'template', 'audio-fx',
]);

export interface EditorMediaDragPayload {
  v: 1;
  source: 'media';
  id: string;
  assetIds?: string[];
  name: string;
  assetKind: MediaAssetKind;
}

export interface EditorLibraryDragPayload {
  v: 1;
  source: 'library';
  id: string;
  name: string;
  resourceKind: LibraryDragKind;
}

export type EditorDragPayload = EditorMediaDragPayload | EditorLibraryDragPayload;
export type EditorDragInput =
  | Omit<EditorMediaDragPayload, 'v'>
  | Omit<EditorLibraryDragPayload, 'v'>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEditorDragPayload(value: unknown): EditorDragPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<EditorDragPayload>;
  if (payload.v !== 1 || !nonEmptyString(payload.id) || !nonEmptyString(payload.name)) return null;
  if (payload.source === 'media') {
    const mediaPayload = payload as Partial<EditorMediaDragPayload>;
    if (mediaPayload.assetIds !== undefined
      && (!Array.isArray(mediaPayload.assetIds) || !mediaPayload.assetIds.every(nonEmptyString))) return null;
    return MEDIA_KINDS.has(mediaPayload.assetKind as MediaAssetKind)
      ? payload as EditorMediaDragPayload
      : null;
  }
  if (payload.source === 'library') {
    const resourceKind = (payload as Partial<EditorLibraryDragPayload>).resourceKind;
    return LIBRARY_KINDS.has(resourceKind as LibraryDragKind)
      ? payload as EditorLibraryDragPayload
      : null;
  }
  return null;
}

export function mediaAssetIds(payload: EditorMediaDragPayload): string[] {
  return [...new Set(payload.assetIds?.length ? payload.assetIds : [payload.id])];
}

export function setEditorDrag(event: React.DragEvent, payload: EditorDragInput): void {
  const full: EditorDragPayload = { v: 1, ...payload } as EditorDragPayload;
  event.dataTransfer.setData(EDITOR_DRAG_MIME, JSON.stringify(full));
  event.dataTransfer.effectAllowed = 'copy';
}

export function parseEditorDrag(event: React.DragEvent): EditorDragPayload | null {
  const raw = event.dataTransfer.getData(EDITOR_DRAG_MIME);
  if (!raw || raw[0] !== '{') return null;
  try {
    return validateEditorDragPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function hasEditorDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes(EDITOR_DRAG_MIME);
}
