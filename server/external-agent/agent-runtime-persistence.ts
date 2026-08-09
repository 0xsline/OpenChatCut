import {
  configureSharedKvBackend,
  type SharedKvBackend,
} from '../../src/persist/sharedKv.ts';
import {
  compareAndSwapAgentRuntime,
  deleteStoredEntry,
  getStoredEntry,
  readStore,
  setStoredEntry,
  updateStoredAgentRunLease,
} from '../plugins/project-store.ts';

const PROJECT_STORE_AGENT_RUNTIME_BACKEND: SharedKvBackend = {
  async get<T>(key: string): Promise<T | undefined> {
    const entry = await getStoredEntry(key);
    return entry.found ? entry.value as T : undefined;
  },
  set: setStoredEntry,
  delete: deleteStoredEntry,
  async keys(): Promise<string[]> {
    return Object.keys((await readStore()).entries);
  },
  compareAndSwapAgentRuntime,
  updateAgentRunLease: (input) => updateStoredAgentRunLease({
    ...input,
    allowOfflineServerTakeover: true,
  }),
};

let offlineAgentRuntimeBackend = PROJECT_STORE_AGENT_RUNTIME_BACKEND;

export function configureOfflineAgentRuntimeBackend(backend: SharedKvBackend): void {
  offlineAgentRuntimeBackend = backend;
  configureSharedKvBackend(backend);
}

export function activateOfflineAgentRuntimeBackend(): void {
  configureSharedKvBackend(offlineAgentRuntimeBackend);
}
