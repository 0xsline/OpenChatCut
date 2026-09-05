// Agent-initiated local-path media import (issue #84 Feature B). Desktop-only:
// the Electron main process scans the requested path, imports files through the
// same fingerprint/reference/probe chain as watched folders, and returns pool-ready
// assets. Browsers have no local filesystem bridge and get a clear error.
import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import { directoryFileToAsset } from '../../media/directoryImportAsset';
import type { AgentPathImportResult } from '../../../shared/directory-import';
import { isAgentLocalMediaRequest, type AgentLocalMediaRequest, type AgentLocalMediaResult } from '../../../shared/agent-local-media';

export const AGENT_PATH_IMPORT_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'browse_local_media',
    description: [
      'Browse local directories or search local media filenames before importing into the media pool.',
      'Desktop only. Defaults to the home directory; absolute paths may include external drives.',
      'Local access is enabled by default; an explicit AGENT_IMPORT_ROOTS setting restricts access.',
      'Returns directories and supported media paths, sizes, and modification times without importing.',
      'Use recursive with query/kind to find candidates, then import_assets for selected files.',
      'Follow nextOffset for more results. If truncated, browse narrower subdirectories; symlinks are not followed.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path; omitted means the user home directory.' },
        query: { type: 'string', maxLength: 256, description: 'Case-insensitive substring of the relative file or directory path.' },
        kind: { type: 'string', enum: ['video', 'audio', 'image', 'gif', 'svg'] },
        recursive: { type: 'boolean', description: 'Search subdirectories, up to 12 levels and 10000 entries. Default false.' },
        offset: { type: 'integer', minimum: 0, maximum: 10000 },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size; default 100.' },
      },
    },
  },
  {
    name: 'import_assets',
    description: 'Import selected local media paths into the media pool in one batch. Desktop only. Local access is enabled by default; explicit AGENT_IMPORT_ROOTS restricts access. Reuses normal media probing and skips duplicate content. Use browse_local_media to find paths first.',
    input_schema: {
      type: 'object',
      properties: {
        paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1 }, description: 'Absolute paths of selected media files.' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'import_asset',
    description: [
      'Import ONE local media file (video/audio/image) by its absolute disk path into the media pool.',
      'Desktop app only; local access is enabled by default. Explicit AGENT_IMPORT_ROOTS restricts access.',
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
      'Desktop app only; local access is enabled by default. Explicit AGENT_IMPORT_ROOTS restricts access.',
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
  browseLocalMedia?(request: AgentLocalMediaRequest): Promise<AgentLocalMediaResult>;
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
  if (!AGENT_PATH_IMPORT_TOOL_NAMES.has(name)) return { error: `unknown tool ${name}` };
  if (name === 'browse_local_media') {
    if (!isAgentLocalMediaRequest(args)) return { error: 'invalid local media browse request' };
    const api = desktopApi();
    if (!api?.browseLocalMedia) return { error: 'browse_local_media is available in the desktop app only' };
    try {
      return { ok: true, ...await api.browseLocalMedia(args) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  const paths = name === 'import_assets' ? args.paths : [rawPath];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100
    || !paths.every((path): path is string => typeof path === 'string' && path.trim().length > 0)) {
    return { error: 'path is required; provide one non-empty path or 1-100 paths for import_assets' };
  }
  const api = desktopApi();
  if (!api?.importAgentPaths) {
    return {
      error: 'local media imports are available in the desktop app only; '
        + 'use the media pool upload UI or watched folders in the browser',
    };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'no open project; open a project before importing local paths' };
  const state = ctx.getState();
  const knownHashes = ctx.getDoc().assets
    .map((asset) => asset.sourceContentHash)
    .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  let result;
  try {
    result = await api.importAgentPaths({ paths, projectId, knownHashes });
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
  if (ctx.getProjectId?.() !== projectId) {
    return { error: 'active project changed during local import; retry in the intended project' };
  }
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
