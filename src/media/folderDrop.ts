import type { DragEvent } from 'react';
import { mediaAssetIds, parseEditorDrag } from '../editor/editorDrag';
import { parseMediaAssetDrag } from './drag';

/** Resolve asset ids from a pool → folder drop (multi-select via editor drag payload). */
export function assetIdsFromFolderDrop(event: Pick<DragEvent, 'dataTransfer'>): string[] {
  const editor = parseEditorDrag(event as DragEvent);
  if (editor?.source === 'media') return mediaAssetIds(editor);
  const assetId = parseMediaAssetDrag(event as DragEvent);
  return assetId ? [assetId] : [];
}
