import assert from 'node:assert/strict';
import {
  loadChat,
  resetProjectStoreMemory,
  saveChat,
  saveServerRunChat,
} from '../persist/projectStore.ts';
import { sanitizePortableChat } from '../persist/projectChatTransfer.ts';
import { finishRecoveredRun } from './serverRunRecovery.ts';
import {
  readStoredServerRun,
  saveStoredServerRun,
} from './serverRunSessionStorage.ts';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

resetProjectStoreMemory();
const projectId = 'server-run-model-history';
const runId = 'run-model-history';
const nextChat = {
  messages: [
    { role: 'user', text: 'first turn' },
    { role: 'assistant', text: 'first answer' },
  ],
  llm: [
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first answer' },
  ],
};
assert.equal(await saveServerRunChat(projectId, runId, nextChat), true);
assert.equal(await saveServerRunChat(projectId, runId, {
  ...nextChat,
  llm: [...nextChat.llm, ...nextChat.llm],
}), false, 'the same terminal run cannot append its model turn twice');
await saveChat(projectId, { ...nextChat, messages: [...nextChat.messages, { role: 'system' }] });
const persisted = await loadChat(projectId);
assert.deepEqual(persisted?.llm, nextChat.llm);
assert.deepEqual(persisted?.serverRunTurnIds, [runId],
  'ordinary chat persistence preserves the atomic server-run commit marker');
assert.equal(sanitizePortableChat(persisted!).serverRunTurnIds, undefined,
  'portable chat never exports local server-run idempotency markers');

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});
try {
  const terminalProject = 'server-run-terminal-barrier';
  const terminalRun = 'run-terminal-barrier';
  assert(saveStoredServerRun(terminalProject, {
    projectId: terminalProject,
    runId: terminalRun,
    content: 'persist this model turn',
  }));
  const releaseCommit = Promise.withResolvers<void>();
  const finishing = finishRecoveredRun({
    projectId: terminalProject,
    runId: terminalRun,
    status: 'completed',
    assistantText: 'durable answer',
    onTerminal: async () => 'finalized' as const,
    commitModelTurn: async () => releaseCommit.promise,
  });
  await Promise.resolve();
  assert.equal(readStoredServerRun(terminalProject)?.runId, terminalRun,
    'terminal recovery credentials remain until model history persistence completes');
  releaseCommit.resolve();
  assert.equal(await finishing, 'finalized');
  assert.equal(readStoredServerRun(terminalProject), null,
    'terminal recovery credentials clear only after the model turn is durable');
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('server run model history verification passed');
