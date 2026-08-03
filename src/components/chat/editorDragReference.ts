import type { AgentReference } from '../../agent/context';
import type { MediaAsset } from '../../editor/types';
import { mediaAssetIds, type EditorDragPayload } from '../../editor/editorDrag';

export function editorDragReference(payload: EditorDragPayload): AgentReference {
  if (payload.source === 'media') {
    return { id: payload.id, name: payload.name, kind: payload.assetKind };
  }
  if (payload.resourceKind === 'template') {
    return { id: payload.id, name: payload.name, kind: 'template' };
  }
  return {
    id: `library:${payload.resourceKind}:${payload.id}`,
    name: payload.name,
    kind: 'library-resource',
    resourceId: payload.id,
    resourceKind: payload.resourceKind,
  };
}

export function editorDragReferences(
  payload: EditorDragPayload,
  assets: readonly Pick<MediaAsset, 'id' | 'name' | 'kind'>[],
): AgentReference[] {
  if (payload.source !== 'media') return [editorDragReference(payload)];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return mediaAssetIds(payload).map((assetId) => {
    const asset = assetById.get(assetId);
    if (asset) return { id: asset.id, name: asset.name, kind: asset.kind };
    if (assetId === payload.id) return editorDragReference(payload);
    return { id: assetId, name: assetId, kind: payload.assetKind };
  });
}
