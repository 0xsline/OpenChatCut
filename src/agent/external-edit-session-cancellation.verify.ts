import assert from 'node:assert/strict';
import { ExternalCallCancellationRegistry } from './external-call-cancellation';
import type { ExternalBridgeBinding } from './external-bridge-runtime';
import {
  externalBridgeCanStart,
  type ExternalBridgeReadinessToken,
} from './external-bridge-readiness';
import {
  ExternalEditSessionOutcomeError,
  revisionOf,
  type ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import {
  executeExternalCall,
  editorInstanceIdForProject,
  hydrateExternalBridge,
  type ExternalResultSender,
} from './useExternalAgentBridge';
import { base } from './external-edit-session-core.verify';
const sessionValues = new Map<string, string>();
const sessionStorageStub = {
  getItem: (key: string) => sessionValues.get(key) ?? null,
  setItem: (key: string, value: string) => { sessionValues.set(key, value); },
};
const refreshIdentity = editorInstanceIdForProject('refresh-project', sessionStorageStub);
assert.equal(
  editorInstanceIdForProject('refresh-project', sessionStorageStub),
  refreshIdentity,
  'a page refresh reuses the tab-scoped editor identity',
);
assert.notEqual(
  editorInstanceIdForProject('other-project', sessionStorageStub),
  refreshIdentity,
  'different project bindings do not share editor identity',
);
const cancellationBeforeRegister = new ExternalCallCancellationRegistry();
cancellationBeforeRegister.cancel('late-call', 'transport closed');
assert.equal(cancellationBeforeRegister.tombstoneCount, 1);
export const lateCall = new AbortController();
cancellationBeforeRegister.register('late-call', lateCall);
assert.equal(lateCall.signal.aborted, true, 'a cancellation received before call registration is not lost');
assert.equal(lateCall.signal.reason, 'transport closed');
assert.equal(cancellationBeforeRegister.tombstoneCount, 0);
cancellationBeforeRegister.release('late-call');

const ownerA = new ExternalCallCancellationRegistry();
const ownerB = new ExternalCallCancellationRegistry();
ownerA.cancel('shared-id', 'owner A cancelled');
const ownerBCall = new AbortController();
ownerB.register('shared-id', ownerBCall);
assert.equal(ownerBCall.signal.aborted, false, 'cancellation tombstones remain isolated to one editor bridge');
const ownerACall = new AbortController();
ownerA.register('shared-id', ownerACall);
assert.equal(ownerACall.signal.aborted, true);
ownerA.abortAll();
ownerB.abortAll();

let cancellationClock = 0;
const expiringCancellations = new ExternalCallCancellationRegistry(2, 10, () => cancellationClock);
expiringCancellations.cancel('expired', 'old cancellation');
cancellationClock = 11;
const expiredCall = new AbortController();
expiringCancellations.register('expired', expiredCall);
assert.equal(expiredCall.signal.aborted, false, 'expired cancellation tombstones cannot cancel later calls');
expiringCancellations.cancel('oldest', 'oldest cancellation');
expiringCancellations.cancel('middle', 'middle cancellation');
expiringCancellations.cancel('newest', 'newest cancellation');
assert.equal(expiringCancellations.tombstoneCount, 2, 'cancellation tombstones stay bounded');
const evictedCall = new AbortController();
expiringCancellations.register('oldest', evictedCall);
assert.equal(evictedCall.signal.aborted, false, 'the oldest tombstone is evicted at the bound');
const retainedCall = new AbortController();
expiringCancellations.register('middle', retainedCall);
assert.equal(retainedCall.signal.aborted, true);
expiringCancellations.abortAll();
const concurrentBinding: ExternalBridgeBinding = {
  projectId: 'runtime-project',
  editorInstanceId: 'runtime-editor',
  baseRevision: revisionOf(base),
};
const concurrentPending = new Map<string, (value: unknown) => void>();
const concurrentSignals = new Map<string, AbortSignal>();
const concurrentRuntime = {
  execute(
    name: string,
    _args: Record<string, unknown>,
    _binding: ExternalBridgeBinding,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assert(signal);
    concurrentSignals.set(name, signal);
    let resolvePending!: (value: unknown) => void;
    let rejectPending!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const cancel = () => rejectPending(new ExternalEditSessionOutcomeError('cancelled', 'call cancelled'));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    concurrentPending.set(name, (value) => {
      signal.removeEventListener('abort', cancel);
      resolvePending(value);
    });
    return promise;
  },
};
const concurrentBridge = new AbortController();
const concurrentCancellations = new ExternalCallCancellationRegistry();
const delivered: Array<{ id: string; outcome: string }> = [];
const deliverResult: ExternalResultSender = async (id, outcome, _value, signal) => {
  assert.equal(signal, concurrentBridge.signal, 'terminal delivery is owned by the bridge signal');
  assert.equal(signal.aborted, false);
  delivered.push({ id, outcome });
};
const cancelledCall = executeExternalCall(
  { id: 'call-a', name: 'call-a', arguments: {}, binding: concurrentBinding },
  concurrentRuntime,
  concurrentBridge.signal,
  concurrentCancellations,
  deliverResult,
);
const survivingCall = executeExternalCall(
  { id: 'call-b', name: 'call-b', arguments: {}, binding: concurrentBinding },
  concurrentRuntime,
  concurrentBridge.signal,
  concurrentCancellations,
  deliverResult,
);
concurrentCancellations.cancel('call-a', 'call timed out');
await cancelledCall;
assert.deepEqual(delivered, [{ id: 'call-a', outcome: 'cancelled' }]);
assert.equal(concurrentBridge.signal.aborted, false, 'one cancelled call does not close its editor bridge');
assert.equal(concurrentSignals.get('call-b')?.aborted, false, 'one cancelled call does not abort sibling work');
const resolveSurvivingCall = concurrentPending.get('call-b');
assert(resolveSurvivingCall);
resolveSurvivingCall({ ok: true });
await survivingCall;
assert.deepEqual(delivered, [
  { id: 'call-a', outcome: 'cancelled' },
  { id: 'call-b', outcome: 'applied' },
]);

const closingBridge = new AbortController();
const closingCancellations = new ExternalCallCancellationRegistry();
const closingOutcomes: string[] = [];
const rejectClosedDelivery: ExternalResultSender = async (_id, outcome, _value, signal) => {
  closingOutcomes.push(outcome);
  assert.equal(signal, closingBridge.signal);
  assert.equal(signal.aborted, true);
  throw new Error('bridge closed');
};
const closingCalls = ['close-a', 'close-b'].map((id) => executeExternalCall(
  { id, name: id, arguments: {}, binding: concurrentBinding },
  concurrentRuntime,
  closingBridge.signal,
  closingCancellations,
  rejectClosedDelivery,
));
closingBridge.abort('transport closed');
const closingResults = await Promise.allSettled(closingCalls);
assert(closingResults.every((result) => result.status === 'rejected'));
assert.equal(concurrentSignals.get('close-a')?.aborted, true);
assert.equal(concurrentSignals.get('close-b')?.aborted, true);
assert.deepEqual(closingOutcomes.sort(), ['cancelled', 'cancelled']);
closingCancellations.abortAll();
const adapterBridge = new AbortController();
const adapterCancellations = new ExternalCallCancellationRegistry();
const adapterDeliveries: Array<{
  outcome: ExternalEditSessionTerminalStatus;
  value: unknown;
}> = [];
const adapterRuntime = {
  async execute(name: string): Promise<unknown> {
    return name === 'oversized-adapter-result'
      ? { payload: 'raw-connected-result-'.repeat(1_000) }
      : { apiKey: 'small-connected-secret', ok: true };
  },
};
const captureAdapterDelivery: ExternalResultSender = async (_id, outcome, value) => {
  adapterDeliveries.push({ outcome, value });
};
await executeExternalCall(
  {
    id: 'oversized-adapter-call',
    name: 'oversized-adapter-result',
    arguments: {},
    binding: concurrentBinding,
  },
  adapterRuntime,
  adapterBridge.signal,
  adapterCancellations,
  captureAdapterDelivery,
);
await executeExternalCall(
  {
    id: 'redacted-adapter-call',
    name: 'small-adapter-result',
    arguments: {},
    binding: concurrentBinding,
  },
  adapterRuntime,
  adapterBridge.signal,
  adapterCancellations,
  captureAdapterDelivery,
);
assert.equal(adapterDeliveries[0]?.outcome, 'failed');
assert.match(String(adapterDeliveries[0]?.value), /no recoverable artifact reference/);
assert.ok(JSON.stringify(adapterDeliveries[0]?.value).length < 300);
assert.deepEqual(adapterDeliveries[1], {
  outcome: 'applied',
  value: { apiKey: '[REDACTED]', ok: true },
});
const tokenA: ExternalBridgeReadinessToken = {
  projectId: 'project-a',
  editorInstanceId: 'editor-a',
  runtimeIdentity: {},
};
const tokenB: ExternalBridgeReadinessToken = {
  projectId: 'project-b',
  editorInstanceId: 'editor-b',
  runtimeIdentity: {},
};
let currentProjectId = tokenA.projectId;
let currentRuntimeToken: ExternalBridgeReadinessToken | null = tokenA;
let readyRuntimeToken: ExternalBridgeReadinessToken | null = tokenA;
let transportAvailable = false;
const bridgeStarts: string[] = [];
const startReadyBridge = () => {
  if (
    readyRuntimeToken
    && currentRuntimeToken
    && externalBridgeCanStart(
      readyRuntimeToken, currentRuntimeToken, currentProjectId, transportAvailable,
    )
  ) {
    bridgeStarts.push(readyRuntimeToken.editorInstanceId);
  }
};
startReadyBridge();
assert.deepEqual(bridgeStarts, [], 'an ordinary browser without transport must not start the bridge');
transportAvailable = true;
startReadyBridge();
currentProjectId = tokenB.projectId;
currentRuntimeToken = tokenB;
startReadyBridge();
assert.deepEqual(
  bridgeStarts,
  ['editor-a'],
  'switching projects invalidates the old readiness before the new runtime hydrates',
);

let resolveBHydration!: (value: null) => void;
const bHydrationPending = new Promise<null>((resolve) => { resolveBHydration = resolve; });
let bHydrateCount = 0;
const bHydration = hydrateExternalBridge(
  tokenB.projectId,
  {
    hydrate: async () => { bHydrateCount += 1; },
  },
  () => currentRuntimeToken?.runtimeIdentity === tokenB.runtimeIdentity,
  (message) => { throw new Error(message); },
  () => {
    readyRuntimeToken = tokenB;
    startReadyBridge();
  },
  async (projectId) => {
    assert.equal(projectId, tokenB.projectId);
    return bHydrationPending;
  },
);
assert.equal(bHydrateCount, 0);
assert.deepEqual(bridgeStarts, ['editor-a'], 'register/poll cannot start before B hydration resolves');
resolveBHydration(null);
await bHydration;
assert.equal(bHydrateCount, 1);
assert.deepEqual(bridgeStarts, ['editor-a', 'editor-b'], 'B starts exactly once after hydration');

const lateTokenA: ExternalBridgeReadinessToken = {
  projectId: 'project-a',
  editorInstanceId: 'editor-a-late',
  runtimeIdentity: {},
};
currentProjectId = lateTokenA.projectId;
currentRuntimeToken = lateTokenA;
let resolveLateA!: (value: null) => void;
const lateAPending = new Promise<null>((resolve) => { resolveLateA = resolve; });
let lateAHydrateCount = 0;
const lateAHydration = hydrateExternalBridge(
  lateTokenA.projectId,
  {
    hydrate: async () => { lateAHydrateCount += 1; },
  },
  () => currentRuntimeToken?.runtimeIdentity === lateTokenA.runtimeIdentity,
  (message) => { throw new Error(message); },
  () => {
    readyRuntimeToken = lateTokenA;
    startReadyBridge();
  },
  async () => lateAPending,
);
currentProjectId = tokenB.projectId;
currentRuntimeToken = tokenB;
readyRuntimeToken = tokenB;
resolveLateA(null);
await lateAHydration;
assert.equal(lateAHydrateCount, 0);
assert.equal(readyRuntimeToken, tokenB, 'a late A hydration cannot overwrite B readiness');
assert.deepEqual(bridgeStarts, ['editor-a', 'editor-b']);

const tokenC: ExternalBridgeReadinessToken = {
  projectId: 'project-c',
  editorInstanceId: 'editor-c',
  runtimeIdentity: {},
};
let resolveC!: (value: null) => void;
const cPending = new Promise<null>((resolve) => { resolveC = resolve; });
let cHydrateCount = 0;
currentProjectId = tokenC.projectId;
currentRuntimeToken = tokenC;
const cHydration = hydrateExternalBridge(
  tokenC.projectId,
  {
    hydrate: async () => { cHydrateCount += 1; },
  },
  () => currentRuntimeToken?.runtimeIdentity === tokenC.runtimeIdentity,
  (message) => { throw new Error(message); },
  () => {
    readyRuntimeToken = tokenC;
    startReadyBridge();
  },
  async () => cPending,
);
currentRuntimeToken = null;
resolveC(null);
await cHydration;
assert.equal(cHydrateCount, 0);
assert.equal(readyRuntimeToken, tokenB, 'unmounted hydration cannot publish readiness or leak a bridge');
assert.deepEqual(bridgeStarts, ['editor-a', 'editor-b']);
