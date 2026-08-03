import type { DragEvent } from 'react';
import type { MediaAsset, TrackKind } from '../editor/types';
import { setEditorDrag } from '../editor/editorDrag';

const MEDIA_DRAG_MIME = 'application/x-openchatcut-media-asset';
const MEDIA_DRAG_KIND_MIME: Record<'video' | 'audio', string> = {
  video: 'application/x-openchatcut-media-video',
  audio: 'application/x-openchatcut-media-audio',
};
const MAX_ASSET_ID_LENGTH = 200;

interface MediaDragPayload {
  v: 1;
  assetId: string;
}

export function mediaAssetTrackKind(asset: Pick<MediaAsset, 'kind'>): 'video' | 'audio' {
  return asset.kind === 'audio' ? 'audio' : 'video';
}

export function setMediaAssetDrag(
  event: DragEvent,
  asset: Pick<MediaAsset, 'id' | 'kind' | 'name'>,
  assetIds?: readonly string[],
): void {
  const kind = mediaAssetTrackKind(asset);
  setEditorDrag(event, {
    source: 'media',
    id: asset.id,
    assetIds: assetIds ? [...assetIds] : undefined,
    name: asset.name,
    assetKind: asset.kind,
  });
  event.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify({ v: 1, assetId: asset.id }));
  event.dataTransfer.setData(MEDIA_DRAG_KIND_MIME[kind], '1');
  event.dataTransfer.effectAllowed = 'copy';
}

export function hasCompatibleMediaDrag(event: DragEvent, trackKind: TrackKind): boolean {
  if (trackKind !== 'video' && trackKind !== 'audio') return false;
  return Array.from(event.dataTransfer.types ?? []).includes(MEDIA_DRAG_KIND_MIME[trackKind]);
}

export function parseMediaAssetDrag(event: DragEvent): string | null {
  return parseMediaAssetDragText(event.dataTransfer.getData(MEDIA_DRAG_MIME));
}

export function parseMediaAssetDragText(raw: string): string | null {
  if (!raw || raw[0] !== '{') return null;
  try {
    const payload = JSON.parse(raw) as Partial<MediaDragPayload>;
    if (payload.v !== 1 || typeof payload.assetId !== 'string') return null;
    const id = payload.assetId.trim();
    const validCharacters = Array.from(id).every((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
    return id && id.length <= MAX_ASSET_ID_LENGTH && validCharacters ? id : null;
  } catch {
    return null;
  }
}

export function canDropMediaAsset(asset: Pick<MediaAsset, 'kind'>, trackKind: TrackKind): boolean {
  return mediaAssetTrackKind(asset) === trackKind;
}
