import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
import {
  projectStoreHttpAuthorized,
  projectStoreReadAuthorized,
} from '../project-store-http-auth.ts';
import { handleProjectStoreRequest, sendProjectStoreJson } from '../project-store-http.ts';
import {
  clearSemanticVectors,
  pruneSemanticVectors,
  searchSemanticVectors,
  upsertSemanticVectors,
} from '../storage/semantic-vectors.ts';
import { searchContent } from '../storage/fulltext-search.ts';
import { hybridSearch } from '../storage/hybrid-search.ts';
import {
  cleanupLegacyJson,
  runStorageMigration,
  sqliteMigrationStatus,
} from '../storage/sqlite-store.ts';
import { AgentSessionClearBlockedError } from './project-store-agent-session.ts';
import {
  compareAndSwapAgentRuntime,
  compareAndSwapProjectDocument,
  deleteStoredEntry,
  getStoredEntry,
  mergeStoredEntries,
  readStore,
  rotateAgentSession,
  setStoredEntry,
  updateStoredAgentRunLease,
  updateExportRecoveryLease,
} from './project-store.ts';

const HTTP_OPERATIONS = {
  compareAndSwapAgentRuntime,
  compareAndSwapProjectDocument,
  deleteEntry: deleteStoredEntry,
  getEntry: getStoredEntry,
  purgeProject: (projectId: string) => deleteStoredEntry(`project:${projectId}`),
  mergeEntries: mergeStoredEntries,
  readSnapshot: readStore,
  rotateAgentSession,
  setEntry: setStoredEntry,
  updateAgentRunLease: updateStoredAgentRunLease,
  updateExportRecoveryLease,
  // Semantic vectors (phase C): sqlite-vec server-side index.
  semanticVectorsUpsert: (request: {
    scopeId: string;
    assetId: string;
    samples: Parameters<typeof upsertSemanticVectors>[2];
  }) => upsertSemanticVectors(request.scopeId, request.assetId, request.samples),
  semanticVectorsSearch: (request: { scopeId: string; queryVector: number[]; limit: number }) =>
    searchSemanticVectors(request.scopeId, request.queryVector, request.limit),
  semanticVectorsPrune: (request: {
    scopeId: string;
    validAssetIds: string[];
    validSourceRevisions?: Record<string, string>;
  }) => pruneSemanticVectors(request.scopeId, request.validAssetIds,
    request.validSourceRevisions ? new Map(Object.entries(request.validSourceRevisions)) : undefined),
  semanticVectorsClear: (request: { scopeId: string }) => clearSemanticVectors(request.scopeId),
};

export function projectStorePlugin(options: { http?: boolean } = {}): Plugin {
  return {
    name: 'openchatcut-project-store',
    configureServer(server) {
      if (options.http === false) return;
      server.middlewares.use('/api/project-store', async (req, res) => {
        // Storage migration: status is read-only (loopback reads allowed),
        // the migration itself is a write and requires a real session.
        if (req.method === 'GET' && req.url === '/migrate-status') {
          if (!projectStoreReadAuthorized(req) && !projectStoreHttpAuthorized(req)) {
            sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
            return;
          }
          sendProjectStoreJson(res, 200, sqliteMigrationStatus());
          return;
        }
        if (req.method === 'POST' && req.url === '/migrate-cleanup') {
          if (!projectStoreHttpAuthorized(req)) {
            sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
            return;
          }
          try {
            const result = cleanupLegacyJson();
            sendProjectStoreJson(res, 200, result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendProjectStoreJson(res, 400, { error: message });
          }
          return;
        }
        if (req.method === 'POST' && req.url === '/migrate') {
          if (!projectStoreHttpAuthorized(req)) {
            sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
            return;
          }
          try {
            const summary = await runStorageMigration();
            const status = sqliteMigrationStatus();
            sendProjectStoreJson(res, 200, { summary, enabled: status.enabled, status });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            server.config.logger.error(`[project-store] migrate failed: ${message}`);
            sendProjectStoreJson(res, 400, { error: message });
          }
          return;
        }
        // Full-text search: read-only, no session needed (loopback same-origin).
        if (req.method === 'GET' && req.url?.startsWith('/search')) {
          if (!projectStoreReadAuthorized(req) && !projectStoreHttpAuthorized(req)) {
            sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
            return;
          }
          try {
            const url = new URL(req.url ?? '', 'http://localhost');
            const query = url.searchParams.get('q')?.trim() ?? '';
            const project = url.searchParams.get('project')?.trim() || undefined;
            const limit = Number(url.searchParams.get('limit') ?? 20);
            if (!query) {
              sendProjectStoreJson(res, 400, { error: 'q is required' });
              return;
            }
            sendProjectStoreJson(res, 200, { hits: searchContent(query, { projectId: project, limit }) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendProjectStoreJson(res, 400, { error: message });
          }
          return;
        }
        // Hybrid search: text (FTS5) + visual (sqlite-vec) fused by RRF.
        if (req.method === 'POST' && req.url === '/hybrid-search') {
          if (!projectStoreReadAuthorized(req) && !projectStoreHttpAuthorized(req)) {
            sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
            return;
          }
          try {
            const body = await readBody(req);
            const query = typeof body.query === 'string' ? body.query.trim() : '';
            const queryVector = Array.isArray(body.queryVector)
              ? (body.queryVector as unknown[]).filter((v): v is number => typeof v === 'number')
              : undefined;
            const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
            const limit = typeof body.limit === 'number' ? body.limit : 20;
            if (!query) {
              sendProjectStoreJson(res, 400, { error: 'query is required' });
              return;
            }
            sendProjectStoreJson(res, 200, {
              hits: hybridSearch(query, queryVector, { projectId, limit }),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendProjectStoreJson(res, 400, { error: message });
          }
          return;
        }
        const readOnly = req.method === 'GET';
        const authorized = readOnly
          ? projectStoreReadAuthorized(req) || projectStoreHttpAuthorized(req)
          : projectStoreHttpAuthorized(req);
        if (!authorized) {
          sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
          return;
        }
        try {
          await handleProjectStoreRequest(req, res, HTTP_OPERATIONS);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[project-store] ${message}`);
          if (!res.headersSent) {
            const body = error instanceof AgentSessionClearBlockedError
              ? { error: message, code: error.code, run: error.run }
              : { error: message };
            sendProjectStoreJson(res, 400, body);
          }
        }
      });
    },
  };
}
