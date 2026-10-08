// Local media endpoints for the built-in Agent in a browser-hosted editor
// (issue #185). The desktop app ships this core over Electron IPC
// (desktop/main.ts), but a browser tab has no bridge, so browse_local_media and
// the import_* tools reach the same modules (server/agent-local-media.ts,
// server/local-path-import.ts) through these same-origin routes instead.
//
// An explicit AGENT_IMPORT_ROOTS allowlist is required here. The desktop app
// treats an empty setting as "trust whoever installed this app", but a page
// load carries no operating-system folder grant, so an empty allowlist refuses
// instead of exposing every path on the machine.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { isAgentLocalMediaRequest } from '../../shared/agent-local-media.ts';
import {
  isDirectoryImportProjectId,
  normalizeDirectoryImportHashes,
} from '../../shared/directory-import.ts';
import { browseLocalMedia } from '../agent-local-media.ts';
import { agentImportRootsConfigured, importAgentPaths } from '../local-path-import.ts';
import { projectStoreHttpAuthorized } from '../project-store-http-auth.ts';
import { UploadTooLargeError } from '../r2.ts';
import { readBody, sendError, sendJson } from './upload-route-http.ts';

export const LOCAL_MEDIA_BROWSE_PATH = '/api/local-media/browse';
export const LOCAL_MEDIA_IMPORT_PATH = '/api/local-media/import';

const MAX_IMPORT_PATHS = 100;
/** A browse request is tiny, but an import carries the pool's whole content-hash
 *  list for dedup, which outgrows the 64 KiB upload default on a large project. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const ROOTS_NOT_CONFIGURED = 'local media access needs an explicit AGENT_IMPORT_ROOTS '
  + 'allowlist in a browser editor: set it to comma-separated absolute directories and '
  + 'restart the server';

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, MAX_JSON_BYTES);
  const parsed: unknown = JSON.parse(raw.toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The same local-device check every other write route runs, repeated here so
 *  this route never depends on the shared shape gate's mount order. */
function authorized(req: IncomingMessage, res: ServerResponse): boolean {
  if (projectStoreHttpAuthorized(req)) return true;
  req.resume();
  sendError(res, 403, 'local media access is not authorized for this request');
  return false;
}

function allowlisted(req: IncomingMessage, res: ServerResponse): boolean {
  if (agentImportRootsConfigured()) return true;
  req.resume();
  sendJson(res, 403, { error: ROOTS_NOT_CONFIGURED, code: 'IMPORT_ROOTS_NOT_CONFIGURED' });
  return false;
}

function sendBodyError(res: ServerResponse, error: unknown): void {
  if (error instanceof UploadTooLargeError) {
    sendError(res, 413, 'request body too large');
    return;
  }
  sendError(res, 400, error instanceof Error ? error.message : String(error));
}

/** Reject before touching the disk: 1-100 non-empty absolute-path strings. */
function importPaths(body: Record<string, unknown>): string[] | null {
  const paths = body.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_IMPORT_PATHS
    || !paths.every((path): path is string => typeof path === 'string' && path.trim().length > 0)) {
    return null;
  }
  return paths;
}

async function handleBrowse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    sendError(res, 405, 'method not allowed — use POST');
    return;
  }
  if (!authorized(req, res) || !allowlisted(req, res)) return;
  try {
    const body = await readJsonObject(req);
    if (!isAgentLocalMediaRequest(body)) {
      sendError(res, 400, 'invalid local media browse request');
      return;
    }
    sendJson(res, 200, await browseLocalMedia(body));
  } catch (error) {
    sendBodyError(res, error);
  }
}

async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    sendError(res, 405, 'method not allowed — use POST');
    return;
  }
  if (!authorized(req, res) || !allowlisted(req, res)) return;
  try {
    const body = await readJsonObject(req);
    const paths = importPaths(body);
    if (!paths) {
      sendError(res, 400, `paths must contain 1-${MAX_IMPORT_PATHS} non-empty paths`);
      return;
    }
    if (!isDirectoryImportProjectId(body.projectId)) {
      sendError(res, 400, 'a valid projectId is required');
      return;
    }
    const knownHashes = normalizeDirectoryImportHashes(body.knownHashes ?? []);
    if (!knownHashes) {
      sendError(res, 400, 'knownHashes must be SHA-256 hex digests');
      return;
    }
    sendJson(res, 200, await importAgentPaths({ paths, projectId: body.projectId, knownHashes }));
  } catch (error) {
    sendBodyError(res, error);
  }
}

/** Vite ignores a rejected middleware promise, so turn handler bugs into a 500
 *  instead of an unhandled rejection that stalls the request. */
function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  void handler(req, res).catch((error) => {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  });
}

export function localMediaPlugin(): Plugin {
  return {
    name: 'openchatcut-local-media',
    configureServer(server) {
      server.middlewares.use(LOCAL_MEDIA_BROWSE_PATH, (req, res) => serve(handleBrowse, req, res));
      server.middlewares.use(LOCAL_MEDIA_IMPORT_PATH, (req, res) => serve(handleImport, req, res));
    },
  };
}
