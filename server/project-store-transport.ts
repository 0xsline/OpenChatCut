import type {
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../shared/project-store-transport.ts';
import { isProjectStoreRequest } from '../shared/project-store-validation.ts';
import {
  deleteStoredEntry,
  getStoredEntry,
  mergeStoredEntries,
  readStore,
  setStoredEntry,
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
    case 'set':
      await setStoredEntry(request.key, request.value);
      return { ok: true };
    case 'delete':
      await deleteStoredEntry(request.key);
      return { ok: true };
  }
}
