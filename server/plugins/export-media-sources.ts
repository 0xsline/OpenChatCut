// POST /api/export-media-sources — disk locations of the timeline's upload-backed
// media for one FCPXML export (issue #27). The renderer uses the answer only to
// write that file; nothing here is persisted into the project.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  EXPORT_MEDIA_SOURCES_ROUTE,
  MAX_EXPORT_MEDIA_SOURCES,
  type ExportMediaSourceMap,
} from '../../shared/export-media-sources.ts';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { resolveExportMediaSources } from '../export-media-sources.ts';
import { readJsonBody, sendJson } from './export-http.ts';

const MAX_SOURCE_LENGTH = 4096;

export interface ExportMediaSourcesRouteDependencies {
  authorized(req: IncomingMessage): boolean;
  resolve(sources: readonly string[]): ExportMediaSourceMap;
}

const defaultDependencies: ExportMediaSourcesRouteDependencies = {
  // The answer holds absolute source paths: same gate as upload mutations
  // (loopback socket, local Host, same-origin Origin), not just the shape gate.
  authorized: (req) => editorCredentialAuthorized(req, true),
  resolve: (sources) => resolveExportMediaSources(sources),
};

function requestedSources(body: unknown): string[] | null {
  const sources = (body as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(sources) || sources.length > MAX_EXPORT_MEDIA_SOURCES) return null;
  const valid = sources.every((source) => typeof source === 'string' && source.length <= MAX_SOURCE_LENGTH);
  return valid ? sources as string[] : null;
}

export async function handleExportMediaSourcesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  overrides: Partial<ExportMediaSourcesRouteDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    req.resume();
    sendJson(res, 405, { error: 'method not allowed — use POST' });
    return;
  }
  if (!dependencies.authorized(req)) {
    req.resume();
    sendJson(res, 403, { error: 'local editor request required' });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' });
    return;
  }
  const sources = requestedSources(body);
  if (!sources) {
    sendJson(res, 400, { error: `sources must be an array of at most ${MAX_EXPORT_MEDIA_SOURCES} strings` });
    return;
  }
  sendJson(res, 200, { ok: true, sources: dependencies.resolve(sources) });
}

export function exportMediaSourcesPlugin(): Plugin {
  return {
    name: 'openchatcut-export-media-sources',
    configureServer(server) {
      server.middlewares.use(EXPORT_MEDIA_SOURCES_ROUTE, (req, res) => {
        handleExportMediaSourcesRequest(req, res).catch((error: unknown) => {
          server.config.logger.error(`[export-media-sources] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) sendJson(res, 500, { error: 'media source resolution failed' });
        });
      });
    },
  };
}
