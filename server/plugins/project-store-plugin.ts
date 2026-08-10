import type { Plugin } from 'vite';
import {
  exchangeProjectStoreLaunchToken,
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
import { sqliteMigrationStatus, sqliteImportJson, sqliteStoreEnabled } from '../storage/sqlite-store.ts';
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
        if (req.method === 'POST' && req.url === '/session') {
          const session = exchangeProjectStoreLaunchToken(req);
          sendProjectStoreJson(
            res,
            session ? 200 : 403,
            session ?? { error: 'invalid or expired editor launch credential' },
          );
          return;
        }
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
        if (req.method === 'POST' && req.url === '/migrate') {
          if (!projectStoreHttpAuthorized(req)) {
            sendProjectStoreJson(res, 403, { error: 'invalid project store session' });
            return;
          }
          try {
            const summary = sqliteImportJson();
            sendProjectStoreJson(res, 200, { summary, enabled: sqliteStoreEnabled() });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            server.config.logger.error(`[project-store] migrate failed: ${message}`);
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
          if (!res.headersSent) sendProjectStoreJson(res, 400, { error: message });
        }
      });
    },
  };
}
