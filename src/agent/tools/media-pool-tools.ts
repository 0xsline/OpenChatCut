export { MEDIA_POOL_TOOL_SCHEMAS, MEDIA_POOL_TOOL_NAMES } from './schemas/media-pool-tools';
import type { AgentContext } from '../context';
import { createMediaSourceRevision } from '../../editor/mediaSourceRevision';
import type { MediaAsset, MediaFolder, ProjectDoc } from '../../editor/types';

type Args = Record<string, unknown>;

function pathOf(folder: MediaFolder, doc: ProjectDoc): string {
  const parts = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = doc.mediaFolders.find((item) => item.id === parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return `Master/${parts.join('/')}`;
}

function findFolder(doc: ProjectDoc, ref: unknown): MediaFolder | null | undefined {
  const query = String(ref ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!query || query === 'Master') return undefined;
  const normalized = query.startsWith('Master/') ? query : `Master/${query}`;
  return doc.mediaFolders.find((folder) => folder.id === query || folder.id.startsWith(query) || pathOf(folder, doc) === normalized) ?? null;
}

function findAsset(doc: ProjectDoc, ref: string): MediaAsset | null {
  return doc.assets.find((asset) => asset.id === ref || asset.id.startsWith(ref) || asset.name === ref) ?? null;
}

function validName(value: unknown): string | null {
  const name = String(value ?? '').trim();
  return name && !name.includes('/') ? name : null;
}

function parseAssetRefs(args: Args): string[] {
  return String(args.assetIds ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

function resolveAssets(doc: ProjectDoc, refs: string[]): { found: MediaAsset[]; missing: string[] } {
  const found = refs.map((ref) => findAsset(doc, ref));
  const missing = refs.filter((_, index) => !found[index]);
  return { found: found.filter((asset): asset is MediaAsset => !!asset), missing };
}

function referencingClipCount(items: { templateId?: string; src?: string }[], asset: MediaAsset): number {
  return items.filter((item) => (
    (asset.kind === 'motion-graphic' && item.templateId === asset.id)
    || (!!asset.src && item.src === asset.src)
  )).length;
}

export async function execMediaPoolTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_media_pool') return { error: `unknown tool ${name}` };
  const doc = ctx.getDoc();
  switch (String(args.action)) {
    case 'list':
      return {
        folders: doc.mediaFolders.map((folder) => ({ id: folder.id, name: folder.name, path: pathOf(folder, doc), parentId: folder.parentId ?? null })),
        assets: doc.assets.map((asset) => {
          const folder = doc.mediaFolders.find((item) => item.id === asset.folderId);
          return { id: asset.id, name: asset.name, kind: asset.kind, folder: folder ? pathOf(folder, doc) : 'Master', favorite: asset.favorite ?? false };
        }),
      };
    case 'create_folder': {
      const folderName = validName(args.name);
      if (!folderName) return { error: 'name is required and cannot contain /' };
      const parent = findFolder(doc, args.parentPath);
      if (parent === null) return { error: `parent folder not found: ${args.parentPath}` };
      const existing = doc.mediaFolders.find((folder) => folder.parentId === parent?.id && folder.name === folderName);
      if (existing) return { ok: true, created: false, folder: { id: existing.id, path: pathOf(existing, doc) } };
      const id = ctx.commands.createMediaFolder(folderName, parent?.id);
      const created = ctx.getDoc().mediaFolders.find((folder) => folder.id === id)!;
      return { ok: true, created: true, folder: { id, path: pathOf(created, ctx.getDoc()) } };
    }
    case 'rename_folder': {
      const folder = findFolder(doc, args.folderPath);
      const newName = validName(args.newName);
      if (!folder) return { error: `folder not found: ${args.folderPath}` };
      if (!newName) return { error: 'newName is required and cannot contain /' };
      if (doc.mediaFolders.some((item) => item.id !== folder.id && item.parentId === folder.parentId && item.name === newName)) return { error: `folder already exists: ${newName}` };
      ctx.commands.renameMediaFolder(folder.id, newName);
      const updated = ctx.getDoc().mediaFolders.find((item) => item.id === folder.id)!;
      return { ok: true, folder: { id: updated.id, path: pathOf(updated, ctx.getDoc()) } };
    }
    case 'delete_empty_folder': {
      const folder = findFolder(doc, args.folderPath);
      if (!folder) return { error: `folder not found: ${args.folderPath}` };
      if (doc.assets.some((asset) => asset.folderId === folder.id) || doc.mediaFolders.some((item) => item.parentId === folder.id)) return { error: 'folder is not empty' };
      ctx.commands.deleteMediaFolder(folder.id);
      return { ok: true, deleted: pathOf(folder, doc) };
    }
    case 'move_assets': {
      const refs = parseAssetRefs(args);
      if (!refs.length) return { error: 'assetIds is required' };
      const { found, missing } = resolveAssets(doc, refs);
      if (missing.length) return { error: `assets not found: ${missing.join(', ')}` };
      const target = findFolder(doc, args.targetPath);
      if (target === null) return { error: `target folder not found: ${args.targetPath}` };
      const ids = found.map((asset) => asset.id);
      ctx.commands.moveMediaAssets(ids, target?.id);
      return { ok: true, moved: ids, target: target ? pathOf(target, doc) : 'Master' };
    }
    case 'rename_asset': {
      const refs = parseAssetRefs(args);
      const newName = String(args.newName ?? '').trim();
      if (refs.length !== 1 || !newName) return { error: 'rename_asset requires one assetIds value and newName' };
      const asset = findAsset(doc, refs[0]!);
      if (!asset) return { error: `asset not found: ${refs[0]}` };
      ctx.commands.renameMediaAsset(asset.id, newName);
      return { ok: true, assetId: asset.id, name: newName };
    }
    case 'favorite_assets':
    case 'unfavorite_assets': {
      const refs = parseAssetRefs(args);
      if (!refs.length) return { error: 'assetIds is required' };
      const { found, missing } = resolveAssets(doc, refs);
      if (missing.length) return { error: `assets not found: ${missing.join(', ')}` };
      const favorite = String(args.action) === 'favorite_assets';
      const ids = found.map((asset) => asset.id);
      if (ids.length === 1) ctx.commands.setMediaAssetFavorite(ids[0]!, favorite);
      else ctx.commands.setMediaAssetsFavorite(ids, favorite);
      return { ok: true, favorite, assetIds: ids };
    }
    case 'delete_assets': {
      const refs = parseAssetRefs(args);
      if (!refs.length) return { error: 'assetIds is required' };
      const { found, missing } = resolveAssets(doc, refs);
      if (missing.length) return { error: `assets not found: ${missing.join(', ')}` };
      const items = ctx.getState().items;
      const referenced = found
        .map((asset) => ({ id: asset.id, name: asset.name, referencedBy: referencingClipCount(items, asset) }))
        .filter((row) => row.referencedBy > 0);
      if (referenced.length && args.confirm !== true) {
        return {
          needsConfirm: true,
          referenced,
          note: 'Deleting only removes pool entries; placed timeline clips keep their media. Resend with confirm:true to proceed.',
        };
      }
      const ids = found.map((asset) => asset.id);
      if (ids.length === 1) ctx.commands.removeMediaAsset(ids[0]!);
      else ctx.commands.removeMediaAssets(ids);
      return { ok: true, deleted: ids, wasReferenced: referenced };
    }
    case 'relink_asset': {
      const refs = parseAssetRefs(args);
      if (refs.length !== 1) return { error: 'relink_asset requires exactly one assetIds value' };
      const asset = findAsset(doc, refs[0]!);
      if (!asset) return { error: `asset not found: ${refs[0]}` };
      if (asset.kind === 'motion-graphic') {
        return { error: 'relink_asset is for file-backed media (video/audio/image); use edit_asset for motion graphics' };
      }
      const src = String(args.src ?? '').trim();
      if (!src) {
        return {
          error: 'relink_asset requires src (replacement path under /media/uploads/… or another reachable media URL)',
        };
      }
      if (src.startsWith('blob:') || src.startsWith('file:')) {
        return { error: 'src must be a project media path or https URL, not a blob:/file: URL' };
      }
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      const sourceFilename = typeof args.sourceFilename === 'string' && args.sourceFilename.trim()
        ? args.sourceFilename.trim()
        : undefined;
      const durationInFrames = typeof args.durationInFrames === 'number' && Number.isFinite(args.durationInFrames) && args.durationInFrames > 0
        ? Math.round(args.durationInFrames)
        : undefined;
      const width = typeof args.width === 'number' && Number.isFinite(args.width) && args.width > 0
        ? Math.round(args.width)
        : undefined;
      const height = typeof args.height === 'number' && Number.isFinite(args.height) && args.height > 0
        ? Math.round(args.height)
        : undefined;
      const sourceRevision = createMediaSourceRevision({
        src,
        name: name ?? asset.name,
        kind: asset.kind,
        durationInFrames: durationInFrames ?? asset.durationInFrames,
        width: width ?? asset.width,
        height: height ?? asset.height,
      });
      const priorSrc = asset.src;
      const clipsBefore = referencingClipCount(ctx.getState().items, asset);
      ctx.commands.relinkMediaAsset(asset.id, {
        src,
        name,
        sourceFilename,
        durationInFrames,
        width,
        height,
        sourceRevision,
      });
      const next = ctx.getDoc().assets.find((row) => row.id === asset.id);
      return {
        ok: true,
        action: 'relink_asset',
        assetId: asset.id,
        priorSrc,
        src: next?.src ?? src,
        sourceRevision: next?.sourceRevision ?? sourceRevision,
        transcriptStale: next?.transcriptStale ?? false,
        clipsLinked: clipsBefore,
        note: 'Pool master and linked timeline clips now point at the new source. Existing transcript is kept but may be marked stale; re-transcribe if the media content changed.',
      };
    }
    default:
      return {
        error: `unknown action ${args.action}; use list/create_folder/rename_folder/delete_empty_folder/move_assets/rename_asset/favorite_assets/unfavorite_assets/delete_assets/relink_asset`,
      };
  }
}
