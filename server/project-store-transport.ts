import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../shared/project-store-transport.ts';
import { isProjectStoreRequest } from '../shared/project-store-validation.ts';
import {
  clearSemanticVectors,
  pruneSemanticVectors,
  searchSemanticVectors,
  upsertSemanticVectors,
} from './storage/semantic-vectors.ts';
import {
  writeAgentRuntime,
  writeProjectDocument,
  deleteStoredEntry,
  getStoredEntry,
  mergeStoredEntries,
  readStore,
  rotateAgentSession,
  setStoredEntry,
  updateStoredAgentRunLease,
  updateExportRecoveryLease,
} from './plugins/project-store.ts';

export async function executeProjectStoreRequest(
  value: unknown,
): Promise<ProjectStoreResponse> {
  if (!isProjectStoreRequest(value)) throw new Error('invalid project store request');
  const request: ProjectStoreRequest = value;
  switch (request.operation) {
    case 'snapshot':
      return readStore();
    case 'entry':
      return getStoredEntry(request.key);
    case 'merge': {
      const merged = await mergeStoredEntries(request.entries);
      const projects = merged.entries.projects;
      return {
        version: 1,
        entries: projects === undefined ? {} : { projects },
      };
    }
    case 'agent-runtime-write':
      return writeAgentRuntime(request);
    case 'project-document-write':
      return writeProjectDocument(request);
    case 'agent-run-lease':
      return updateStoredAgentRunLease(request);
    case 'export-recovery-lease':
      return updateExportRecoveryLease(request);
    case 'agent-session-rotate':
      return rotateAgentSession(request.projectId);
    case 'set':
      if (/^project:[a-zA-Z0-9_-]{1,160}$/.test(request.key)) {
        throw new Error('project document writes require authoritative ownership CAS');
      }
      await setStoredEntry(request.key, request.value);
      return { ok: true };
    case 'delete':
      await deleteStoredEntry(request.key);
      return { ok: true };
    case 'purge-project':
      await deleteStoredEntry(`project:${request.projectId}`);
      return { ok: true };
    case 'semantic-vectors-upsert':
      return { semanticVectors: upsertSemanticVectors(request.scopeId, request.assetId, request.samples) };
    case 'semantic-vectors-search':
      return { semanticVectors: searchSemanticVectors(request.scopeId, request.queryVector, request.limit) };
    case 'semantic-vectors-prune':
      return { semanticVectors: pruneSemanticVectors(request.scopeId, request.validAssetIds,
        request.validSourceRevisions ? new Map(Object.entries(request.validSourceRevisions)) : undefined) };
    case 'semantic-vectors-clear':
      return { semanticVectors: clearSemanticVectors(request.scopeId) };
  }
}
