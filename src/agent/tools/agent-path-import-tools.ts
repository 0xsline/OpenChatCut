// Agent-initiated local-path media import (issue #84 Feature B). Desktop-only:
// the Electron main process scans the requested path (whitelisted by the
// user-configured AGENT_IMPORT_ROOTS), imports files through the same
// fingerprint/copy/probe chain as watched folders, and returns pool-ready
// assets. Browsers have no local filesystem bridge and get a clear error.
import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import { directoryFileToAsset } from '../../media/directoryImportAsset';
import type { DirectoryImportedFile } from '../../../shared/directory-import';

export const AGENT_PATH_IMPORT_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'import_asset',
    description: [
      'Import ONE local media file (video/audio/image) by its absolute disk path into the media pool.',
      'Desktop app only; the path must be inside the allowed import roots configured via AGENT_IMPORT_ROOTS.',
      'Returns the imported pool asset(s); duplicates already in the pool are skipped.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the media file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'import_folder',
    description: [
      'Import every supported media file inside a local directory (recursive, bounded) into the media pool.',
      'Desktop app only; the directory must be inside the allowed import roots configured via AGENT_IMPORT_ROOTS.',
      'Returns the imported pool assets and any per-file errors; duplicates already in the pool are skipped.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the media directory.' },
      },
      required: ['path'],
    },
  },
];

export const AGENT_PATH_IMPORT_TOOL_NAMES = new Set(
  AGENT_PATH_IMPORT_SCHEMAS.map((schema) => schema.name),
);

interface DesktopPathImportApi {
  importAgentPaths(request: {
    paths: readonly string[];
    projectId: string;
    knownHashes: readonly string[];
  }): Promise<{
    imported: ReadonlyArray<Omit<DirectoryImportedFile, 'importId'>>;
    errors: readonly { path: string; error: string }[];
  }>;
}

function desktopApi(): DesktopPathImportApi | null {
  const bridge = (typeof window === 'undefined' ? undefined : window) as unknown as {
    openChatCutDesktop?: DesktopPathImportApi;
  };
  return bridge.openChatCutDesktop ?? null;
}

export async function execAgentPathImportTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<Record<string, unknown>> {
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  if (!rawPath) return { error: 'path is required and must be a non-empty string' };
  const api = desktopApi();
  if (!api) {
    return {
      error: 'import_asset/import_folder are available in the desktop app only; '
        + 'use the media pool upload UI or watched folders in the browser',
    };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'no open project; open a project before importing local paths' };
  const state = ctx.getState();
  const knownHashes = ctx.getDoc().assets
    .map((asset) => asset.sourceContentHash)
    .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  void name; // one executor serves both import_asset and import_folder
  let result;
  try {
    result = await api.importAgentPaths({ paths: [rawPath], projectId, knownHashes });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const assets = await Promise.all(result.imported.map((file) => directoryFileToAsset(
    { ...file, importId: crypto.randomUUID() },
    state.fps,
  )));
  for (const asset of assets) ctx.commands.addAsset(asset);
  return {
    ok: true,
    imported: assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, src: asset.src })),
    skippedDuplicates: !result.imported.length && result.errors.length === 0,
    ...(result.errors.length ? { errors: result.errors.slice(0, 20) } : {}),
  };
}
