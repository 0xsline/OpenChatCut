import assert from 'node:assert/strict';
import { patchAgentRun } from '../persist/agentRuntimeStore.ts';
import {
  bindServerRunEvents,
  ServerRunToolRequestQueue,
} from './serverRunEvents.ts';
import { restoreServerRunToolActivation } from './serverRunProtocol.ts';
import { finishRecoveredRun } from './serverRunRecovery.ts';
import { ServerRunTerminalHandoffs } from './serverRunTerminalHandoff.ts';
import { startAgentRun } from './runtime-ledger.ts';
import { resetAgentRuntimeStoreMemory } from '../persist/agentRuntimeStore.ts';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import {
  beginStoredToolAttempt,
  clearStoredServerRun,
  clearStoredToolAttempt,
  findStoredToolAttempt,
  patchStoredServerRun,
  readStoredServerRun,
  saveStoredServerRun,
  storedClaimIdentity,
} from './serverRunSessionStorage.ts';
// The settle endpoint is server-side; emulate its effect locally (patch the
// sidecar) so verifies exercise the full settlement path without a server.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/settle') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as {
      projectId: string; status: string;
      proposalId?: string; summary?: string;
    };
    const settleRunId = String(url).split('/').filter(Boolean).at(-2) ?? '';
    await patchAgentRun(body.projectId, settleRunId, {
      status: body.status as 'completed' | 'failed' | 'aborted' | 'interrupted'
        | 'waiting_approval' | 'awaiting_user',
      ...(body.summary ? { finalSummary: body.summary } : {}),
    });
    return new Response(JSON.stringify({ ok: true, already: false, gone: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class FakeEventSource {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, data: Record<string, unknown>): void {
    const event = { data: JSON.stringify(data) } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

const projectId = 'server-run-storage';
const runId = 'run-1';
const initialActivation = new ToolActivation(
  TOOL_SCHEMAS,
  [{ role: 'user', content: 'Read the current timeline.' }],
);
const initialNames = initialActivation.names();
assert(saveStoredServerRun(projectId, {
  projectId,
  runId,
  capability: 'raw-tab-capability',
  leaseToken: 'lease-token-1',
  createdAt: 1_000,
  admissionPending: true,
  activeToolNames: initialNames,
  cursor: 0,
  modelHistoryLength: 3,
  content: 'proposal request',
}));
assert.equal(readStoredServerRun(projectId)?.runId, runId);
assert.equal(readStoredServerRun(projectId)?.capability, 'raw-tab-capability');
assert.equal(readStoredServerRun(projectId)?.leaseToken, 'lease-token-1');
assert.equal(readStoredServerRun(projectId)?.createdAt, 1_000);
assert.equal(readStoredServerRun(projectId)?.admissionPending, true);
assert.deepEqual(readStoredServerRun(projectId)?.activeToolNames, initialNames);
clearStoredServerRun(projectId, 'another-run');
assert.equal(readStoredServerRun(projectId)?.runId, runId,
  'settling an older proposal cannot clear a newer stored run');
assert(patchStoredServerRun(projectId, { cursor: 4, assistantText: 'partial' }));
assert.equal(readStoredServerRun(projectId)?.modelHistoryLength, 3);
assert.equal(readStoredServerRun(projectId)?.cursor, 4);
assert.equal(storedClaimIdentity(projectId), storedClaimIdentity(projectId));

const addedTool = TOOL_SCHEMAS.find((schema) => !initialNames.includes(schema.name));
assert(addedTool);
const changedActivation = initialActivation.withSearchResult({
  activatedTools: [addedTool.name],
}).activation;
assert.notDeepEqual(changedActivation.names(), initialNames);
assert(patchStoredServerRun(projectId, {
  activeToolNames: changedActivation.names(),
}));
const restoredActivation = restoreServerRunToolActivation(
  false,
  readStoredServerRun(projectId)?.activeToolNames,
);
assert(restoredActivation);
assert.deepEqual(restoredActivation.names(), changedActivation.names());
assert.equal(restoreServerRunToolActivation(
  false,
  [...changedActivation.names(), 'unknown_tool'],
), null);

assert(beginStoredToolAttempt(projectId, 'call-1', 'digest-1'));
assert.deepEqual(findStoredToolAttempt(projectId, 'call-1'), {
  toolCallId: 'call-1',
  argsDigest: 'digest-1',
});
clearStoredToolAttempt(projectId, 'call-1');
assert.equal(findStoredToolAttempt(projectId, 'call-1'), undefined);
const transientDisposition = await finishRecoveredRun({
  projectId,
  runId,
  status: 'completed',
  assistantText: 'completed while detached',
});
assert.equal(transientDisposition, 'finalized',
  'a terminal run without a terminal handler is settled by the server settle fallback');
assert.equal(readStoredServerRun(projectId), null,
  'a terminal run without a terminal handler settles server-side and clears recovery');

const terminalOrder: string[] = [];
assert(saveStoredServerRun(projectId, {
  projectId,
  runId,
  capability: 'raw-tab-capability',
  createdAt: 1_000,
  content: 'proposal request',
  activeToolNames: initialNames,
  cursor: 0,
  modelHistoryLength: 3,
}), 're-storing the run keeps the waiting-approval settlement path covered');
const waitingDisposition = await finishRecoveredRun({
  projectId,
  runId,
  status: 'completed',
  assistantText: 'proposal ready',
  onTerminal: async () => ({
    disposition: 'waiting_approval' as const,
    afterModelCommit: () => { terminalOrder.push('proposal-exposed'); },
  }),
  commitModelTurn: async () => { terminalOrder.push('model-history-persisted'); },
});
assert.equal(waitingDisposition, 'waiting_approval');
assert.deepEqual(terminalOrder, ['model-history-persisted', 'proposal-exposed'],
  'proposal exposure cannot race ahead of durable model-history commit');
assert.equal(readStoredServerRun(projectId)?.runId, runId,
  'waiting approval retains the stored run for apply or deny');
const handoffs = new ServerRunTerminalHandoffs();
let proposalAttempts = 0;
let handoffSettlements = 0;
const retainedHandoff = handoffs.retain(runId, {
  disposition: 'waiting_approval',
  afterModelCommit: () => {
    proposalAttempts += 1;
    if (proposalAttempts === 1) throw new Error('transient proposal exposure failure');
  },
}, () => { handoffSettlements += 1; });
assert.equal(handoffs.get(runId), retainedHandoff);
await assert.rejects(
  async () => { await retainedHandoff.afterModelCommit(); },
  /transient proposal exposure failure/,
);
assert.equal(handoffs.get(runId), retainedHandoff,
  'a failed terminal handoff remains available for recovery retry');
await retainedHandoff.afterModelCommit();
assert.equal(proposalAttempts, 2);
assert.equal(handoffSettlements, 1);
assert.equal(handoffs.get(runId), null,
  'terminal proposal state is released only after model history and exposure settle');
let staleProposalExposures = 0;
let abandonedProposals = 0;
const abandonedHandoff = handoffs.retain('abandoned-run', {
  disposition: 'waiting_approval',
  afterModelCommit: () => { staleProposalExposures += 1; },
  onAbandon: () => { abandonedProposals += 1; },
}, () => { handoffSettlements += 1; });
await handoffs.clear('abandoned-run');
await abandonedHandoff.afterModelCommit();
assert.equal(staleProposalExposures, 0,
  'an abandoned terminal handoff cannot expose a proposal after project switch');
assert.equal(abandonedProposals, 1,
  'abandonment settles the persisted proposal exactly once');
assert.equal(handoffSettlements, 1,
  'an invalidated handoff cannot run successful-settlement cleanup');

resetAgentRuntimeStoreMemory();
const refreshProjectId = 'waiting-proposal-refresh';
const refreshRecorder = await startAgentRun({
  projectId: refreshProjectId,
  userInput: 'create a proposal',
  askOnly: false,
});
assert(saveStoredServerRun(refreshProjectId, {
  projectId: refreshProjectId,
  runId: refreshRecorder.runId,
  capability: 'proposal-capability',
  leaseToken: refreshRecorder.recoveryLeaseToken(),
  content: 'create a proposal',
}));
const refreshDisposition = await finishRecoveredRun({
  projectId: refreshProjectId,
  runId: refreshRecorder.runId,
  status: 'completed',
  assistantText: 'proposal ready',
  onTerminal: async (): Promise<'waiting_approval'> => 'waiting_approval' as const,
});
assert.equal(refreshDisposition, 'waiting_approval');
clearStoredServerRun(refreshProjectId, refreshRecorder.runId);
const finalDisposition = await finishRecoveredRun({
  projectId,
  runId,
  status: 'completed',
  assistantText: 'no proposal',
});
assert.equal(finalDisposition, 'finalized');
assert.equal(readStoredServerRun(projectId), null,
  'a finalized no-proposal run clears recovery exactly once');
clearStoredServerRun(projectId, runId);
assert.equal(readStoredServerRun(projectId), null,
  'permanent stale cleanup is idempotent');
assert(saveStoredServerRun(projectId, {
  projectId,
  runId,
  leaseToken: 'lease-token-1',
}));
const handledDisposition = await finishRecoveredRun({
  projectId,
  runId,
  status: 'failed',
  assistantText: 'failed once',
  onTerminal: async () => 'finalized' as const,
});
assert.equal(handledDisposition, 'finalized');
assert.equal(readStoredServerRun(projectId), null);


const source = new FakeEventSource();
const requestQueue = new ServerRunToolRequestQueue();
const receivedUsages: unknown[] = [];
const firstToolRelease = Promise.withResolvers<void>();
const bothToolsHandled = Promise.withResolvers<void>();
const executionOrder: string[] = [];
const attributedActions: Array<{ toolCallId: string; actions: string[] }> = [];
let handledCount = 0;
const appendedMessages: string[] = [];
bindServerRunEvents(source as never, runId, {
  enabled: () => true,
  ready: () => true,
  commit: () => 'committed',
  commitTextDelta: () => 'committed',
  commitThinkingDelta: () => 'committed',
  ensureAssistantMessage: () => undefined,
  onContextUsage: (usage) => { receivedUsages.push(usage); },
  handleToolRequest: (
    _eventRunId, toolCallId, _name, _args, _digest, admit,
  ) => requestQueue.enqueueExclusive(runId, async () => {
      if (!admit()) return false;
      executionOrder.push(`start:${toolCallId}`);
      const actions = [`action:${toolCallId}`];
      if (toolCallId === 'call-1') await firstToolRelease.promise;
      attributedActions.push({ toolCallId, actions });
      executionOrder.push(`end:${toolCallId}`);
      handledCount += 1;
      if (handledCount === 2) bothToolsHandled.resolve();
      return true;
    },
  ),
  retry: () => undefined,
  finish: () => undefined,
  appendMessage: (message) => { appendedMessages.push(`${message.role}:${message.text}`); },
  transportError: () => undefined,
  persistenceError: () => undefined,
  opened: () => undefined,
});
source.emit('max-turns', { turns: 30 });
assert.deepEqual(appendedMessages, ['continue:30']);
source.emit('context-usage', { usage: { inputTokens: 10, outputTokens: 20 } });
source.emit('context-usage', { usage: 'not-an-object' });
assert.deepEqual(receivedUsages, [{ inputTokens: 10, outputTokens: 20 }],
  'context-usage events dispatch valid usage payloads and ignore malformed ones');
source.emit('tool-request', {
  toolCallId: 'call-1',
  name: 'read_timeline',
  args: {},
  argsDigest: 'digest-1',
});
source.emit('tool-request', {
  toolCallId: 'call-2',
  name: 'read_project',
  args: {},
  argsDigest: 'digest-2',
});
await Promise.resolve();
assert.deepEqual(executionOrder, ['start:call-1']);
firstToolRelease.resolve();
await bothToolsHandled.promise;
assert.deepEqual(executionOrder, [
  'start:call-1',
  'end:call-1',
  'start:call-2',
  'end:call-2',
]);
assert.deepEqual(attributedActions, [
  { toolCallId: 'call-1', actions: ['action:call-1'] },
  { toolCallId: 'call-2', actions: ['action:call-2'] },
]);

// Parallel queue semantics: pure-read tools overlap; exclusive tools still
// form a barrier against both the exclusive chain and in-flight reads.
const parallelOrder: string[] = [];
const p1Started = Promise.withResolvers<void>();
const p1Release = Promise.withResolvers<void>();
const p1 = requestQueue.enqueueParallel(runId, async () => {
  parallelOrder.push('start:p1');
  p1Started.resolve();
  await p1Release.promise;
  parallelOrder.push('end:p1');
});
const p2 = requestQueue.enqueueParallel(runId, async () => {
  parallelOrder.push('start:p2');
  parallelOrder.push('end:p2');
});
await p1Started.promise;
assert.ok(
  parallelOrder.includes('start:p2') && !parallelOrder.includes('end:p1'),
  'parallel reads overlap before the first one finishes',
);
// An exclusive tool waits for in-flight parallel work.
const eOrder: string[] = [];
const e1 = requestQueue.enqueueExclusive(runId, async () => { eOrder.push('e1'); });
await Promise.resolve();
assert.deepEqual(eOrder, [], 'exclusive waits for in-flight parallel');
p1Release.resolve();
await p1;
await p2;
await e1;
assert.deepEqual(parallelOrder, ['start:p1', 'start:p2', 'end:p2', 'end:p1']);

const earlySource = new FakeEventSource();
let earlyRetries = 0;
let earlyExecutions = 0;
bindServerRunEvents(earlySource as never, runId, {
  enabled: () => true,
  ready: () => false,
  commit: () => 'committed',
  commitTextDelta: () => 'committed',
  commitThinkingDelta: () => 'committed',
  ensureAssistantMessage: () => undefined,
  onContextUsage: () => undefined,
  handleToolRequest: async () => {
    earlyExecutions += 1;
    return true;
  },
  retry: () => { earlyRetries += 1; },
  finish: () => undefined,
  appendMessage: () => undefined,
  transportError: () => undefined,
  persistenceError: () => undefined,
  opened: () => undefined,
});
earlySource.emit('tool-request', {
  toolCallId: 'call-before-ready',
  name: 'read_project',
  args: {},
  argsDigest: 'digest-before-ready',
});
await Promise.resolve();
assert.equal(earlyExecutions, 0, 'tool requests never run before proposal recovery is ready');
assert.equal(earlyRetries, 1, 'an early tool request reconnects for durable replay');
const failedSource = new FakeEventSource();
let persistenceFailures = 0;
let persistenceRetries = 0;
let failedToolExecutions = 0;
bindServerRunEvents(failedSource as never, runId, {
  enabled: () => true,
  ready: () => true,
  commit: () => 'failed',
  commitTextDelta: () => 'failed',
  commitThinkingDelta: () => 'failed',
  ensureAssistantMessage: () => undefined,
  onContextUsage: () => undefined,
  handleToolRequest: async (_id, _callId, _name, _args, _digest, admit) => {
    if (!admit()) return false;
    failedToolExecutions += 1;
    return true;
  },
  retry: () => { persistenceRetries += 1; },
  finish: () => undefined,
  appendMessage: () => undefined,
  transportError: () => undefined,
  persistenceError: () => { persistenceFailures += 1; },
  opened: () => undefined,
});
failedSource.emit('text-delta', { text: 'durable delta' });
assert.equal(persistenceFailures, 1,
  'a durable cursor write failure enters permanent settlement instead of replay');
assert.equal(persistenceRetries, 0,
  'a durable cursor write failure does not reconnect and replay the same event forever');
persistenceFailures = 0;
failedSource.emit('tool-request', {
  toolCallId: 'failed-tool',
  name: 'edit_item',
  args: { id: 'clip-1' },
  argsDigest: 'failed-digest',
});
await Promise.resolve();
assert.equal(failedToolExecutions, 0,
  'a failed durable cursor write never executes the browser tool');
assert.equal(persistenceRetries, 0,
  'a failed durable cursor write does not replay into a later execution');
assert.equal(persistenceFailures, 1,
  'a failed durable cursor write enters permanent settlement');


if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
else Reflect.deleteProperty(globalThis, 'sessionStorage');

console.log('server run session storage verification passed');
