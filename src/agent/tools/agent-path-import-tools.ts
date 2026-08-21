// Agent-initiated local-path media import (issue #84 Feature B). Desktop-only:
// the Electron main process scans the requested path (whitelisted by the
// user-configured AGENT_IMPORT_ROOTS), imports files through the same
// fingerprint/copy/probe chain as watched folders, and returns pool-ready
// assets. Browsers have no local filesystem bridge and get a clear error.
import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import { directoryFileToAsset } from '../../media/directoryImportAsset';
import type { AgentPathImportResult } from '../../../shared/directory-import';

export const AGENT_PATH_IMPORT_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'import_asset',
    description: [
      'Import ONE local media file (video/audio/image) by its absolute disk path into the media pool.',
      'Desktop app only; the path must be inside an allowed AGENT_IMPORT_ROOTS directory.',
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
      'Desktop app only; the directory must be inside an allowed AGENT_IMPORT_ROOTS directory.',
      'Returns imported assets, duplicate counts, unsupported file names, and per-file errors.',
      'Documents (txt/md/docx/pdf) are reported as unsupported here and should be attached to chat instead.',
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
  }): Promise<AgentPathImportResult>;
}

function desktopApi(): DesktopPathImportApi | null {
  const bridge = (typeof window === 'undefined' ? undefined : window) as unknown as {
    openChatCutDesktop?: DesktopPathImportApi;
  };
  return bridge?.openChatCutDesktop ?? null;
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
  if (!result.imported.length && result.errors.length) {
    const first = result.errors[0]!;
    return {
      error: first.error,
      ...(first.code ? { code: first.code } : {}),
      errors: result.errors.slice(0, 20),
    };
  }
  const assets = await Promise.all(result.imported.map((file) => directoryFileToAsset(
    { ...file, importId: crypto.randomUUID() },
    state.fps,
  )));
  for (const asset of assets) ctx.commands.addAsset(asset);
  return {
    ok: true,
    imported: assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, src: asset.src })),
    duplicateCount: result.duplicateCount,
    skippedDuplicates: result.duplicateCount > 0
      && !assets.length && !result.errors.length && !result.unsupportedFiles.length,
    ...(result.unsupportedFiles.length ? { unsupportedFiles: result.unsupportedFiles.slice(0, 50) } : {}),
    ...(result.errors.length ? { errors: result.errors.slice(0, 20) } : {}),
  };
}
