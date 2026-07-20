import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { MediaAsset, MediaFolder, ProjectDoc } from '../../editor/types';

type Args = Record<string, unknown>;

export const MEDIA_POOL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_media_pool',
  description: 'Organize the project media pool without changing timeline clips or source files: list, create/rename/delete empty folders, move assets, or rename an asset display name.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create_folder', 'rename_folder', 'delete_empty_folder', 'move_assets', 'rename_asset'] },
      assetIds: { type: 'string', description: 'Comma-separated asset ids/prefixes for move_assets; one asset id/prefix for rename_asset.' },
      folderPath: { type: 'string', description: 'Folder path such as Master/B-roll, or folder id prefix.' },
      name: { type: 'string', description: 'New folder name for create_folder; cannot contain /.' },
      newName: { type: 'string', description: 'New folder or asset display name for rename actions.' },
      parentPath: { type: 'string', description: 'Parent folder path for create_folder; defaults to Master.' },
      targetPath: { type: 'string', description: 'Destination folder path for move_assets; defaults to Master.' },
    },
    required: ['action'],
  },
}];

export const MEDIA_POOL_TOOL_NAMES = new Set(MEDIA_POOL_TOOL_SCHEMAS.map((tool) => tool.name));

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
      const refs = String(args.assetIds ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      if (!refs.length) return { error: 'assetIds is required' };
      const found = refs.map((ref) => findAsset(doc, ref));
      const missing = refs.filter((_, index) => !found[index]);
      if (missing.length) return { error: `assets not found: ${missing.join(', ')}` };
      const target = findFolder(doc, args.targetPath);
      if (target === null) return { error: `target folder not found: ${args.targetPath}` };
      const ids = found.map((asset) => asset!.id);
      ctx.commands.moveMediaAssets(ids, target?.id);
      return { ok: true, moved: ids, target: target ? pathOf(target, doc) : 'Master' };
    }
    case 'rename_asset': {
      const refs = String(args.assetIds ?? '').split(',').map((id) => id.trim()).filter(Boolean);
      const newName = String(args.newName ?? '').trim();
      if (refs.length !== 1 || !newName) return { error: 'rename_asset requires one assetIds value and newName' };
      const asset = findAsset(doc, refs[0]);
      if (!asset) return { error: `asset not found: ${refs[0]}` };
      ctx.commands.renameMediaAsset(asset.id, newName);
      return { ok: true, assetId: asset.id, name: newName };
    }
    default:
      return { error: `unknown action ${args.action}; use list/create_folder/rename_folder/delete_empty_folder/move_assets/rename_asset` };
  }
}
