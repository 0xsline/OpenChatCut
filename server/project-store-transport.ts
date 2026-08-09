import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../shared/project-store-transport.ts';
import { isProjectStoreRequest } from '../shared/project-store-validation.ts';
import {
  compareAndSwapAgentRuntime,
  compareAndSwapProjectDocument,
  deleteStoredEntry,
  getStoredEntry,
  mergeStoredEntries,
  readStore,
  setStoredEntry,
  updateStoredAgentRunLease,
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
    case 'agent-runtime-cas':
      return compareAndSwapAgentRuntime(request);
    case 'project-document-cas':
      return compareAndSwapProjectDocument(request);
    case 'agent-run-lease':
      return updateStoredAgentRunLease(request);
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
  }
}
