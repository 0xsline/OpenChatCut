import assert from 'node:assert/strict';
import {
  cancelRun,
  claimToolRequest,
  createRun,
  digestToolArgs,
  flushRunPersistence,
  flushServerRunPersistence,
  getRun,
  persistServerCheckpoint,
  prepareRunAdmission,
  recordServerContextUsage,
  pushRunEvent,
  recoverServerRun,
  recoverServerRuns,
  resetServerRunStoreForTest,
  setRunStatus,
  settleToolResult,
  waitForRunEvents,
  MAX_ACTIVE_SERVER_RUNS,
  MAX_SERVER_RUN_EVENTS,
  waitForToolResult,
} from './store.ts';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory,
} from '../../src/persist/agentRuntimeStore.ts';
import {
  currentAgentSessionGeneration,
  rotateAgentSessionGeneration,
} from '../../src/persist/agentSessionGeneration.ts';
import { resetSharedKvMemory } from '../../src/persist/sharedKv.ts';
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) => (
    byte.toString(16).padStart(2, '0')
  )).join('');
}

function run(projectId = 'server-run-contract') {
  return createRun({
    projectId,
    sessionGeneration: 'legacy',
    provider: 'deepseek',
    model: 'test-model',
    references: [{ id: 'ref-1' }],
    externalSessionId: 'session-1',
  });
}

resetServerRunStoreForTest();
resetAgentRuntimeStoreMemory();
resetSharedKvMemory();

// The append-only cursor is the SSE replay contract: a subscriber resumes strictly
// after its last observed sequence and is woken only by a newer event or settlement.
const streamed = run();
pushRunEvent(streamed, 'text-delta', { text: 'first' });
const afterFirst = streamed.eventCursor;
const waiting = waitForRunEvents(streamed, afterFirst);
pushRunEvent(streamed, 'text-delta', { text: 'second' });
await waiting;
assert.deepEqual(
  streamed.events.filter((event) => event.id > afterFirst).map(({ id, type, data }) => ({ id, type, data })),
  [{ id: afterFirst + 1, type: 'text-delta', data: { text: 'second' } }],
  'reconnecting after a cursor receives each later event exactly once',
);
assert.deepEqual(
  streamed.events.filter((event) => event.id > streamed.eventCursor),
  [],
  'reconnecting at the latest cursor does not replay an already consumed event',
);
const terminalSettlement = setRunStatus(streamed, 'completed');
assert.notEqual(
  streamed.events.at(-1)?.type,
  'done',
  'terminal done is not observable before the durability barrier resolves',
);
await terminalSettlement;
await waitForRunEvents(streamed, streamed.eventCursor);
assert.equal(streamed.status, 'completed', 'a terminal run releases subscribers so SSE can close');
assert.deepEqual(
  streamed.events.map((event) => event.id),
  streamed.events.map((_, index) => index + 1),
  'event sequences are stable and contiguous for SSE Last-Event-ID',
);
await flushServerRunPersistence(streamed);
const persisted = await loadAgentRuntimeSidecar(streamed.projectId);
const persistedRun = persisted.runs.find((item) => item.runId === streamed.id);
assert(persistedRun, 'server run is durable');
assert.equal(persistedRun?.externalSessionId, 'session-1');
assert.deepEqual(persistedRun?.context?.modelId, 'test-model');
assert(persistedRun?.events.some((event) => event.summary?.includes('serverEvent')), 'server events are durable');
const persistedServerEventIds = persistedRun?.events.flatMap((event) => {
  try {
    const payload = JSON.parse(event.summary ?? '') as {
      serverEvent?: { id?: unknown };
    };
    const id = payload.serverEvent?.id;
    return typeof id === 'number' && Number.isSafeInteger(id)
      ? [id]
      : [];
  } catch {
    return [];
  }
}) ?? [];
assert.deepEqual(
  persistedServerEventIds,
  streamed.events.map((event) => event.id),
  'terminal done becomes visible only after every prior event is durably ordered',
);
assert.equal(
  persistedRun?.status,
  'running',
  'server transport completion does not preempt browser AgentRun finalization',
);
assert.equal(persistedRun?.context?.transportStatus, 'completed');
assert.equal(persistedRun?.context?.transportError, null);
resetServerRunStoreForTest();
const recoveredCompleted = await recoverServerRuns(streamed.projectId);
assert.equal(
  recoveredCompleted.find((item) => item.id === streamed.id)?.error,
  null,
  'a recovered completed run does not expose its success summary as an error',
);
resetServerRunStoreForTest();
const interrupted = run('server-run-interrupted-recovery');
await setRunStatus(interrupted, 'running');
pushRunEvent(interrupted, 'diagnostic', { phase: 'provider-started' });
await flushRunPersistence(interrupted);
resetServerRunStoreForTest();
const recoveredInterrupted = await recoverServerRun(
  interrupted.projectId,
  interrupted.id,
);
assert.equal(
  recoveredInterrupted?.status,
  'failed',
  'restart recovery fails genuinely unfinished server transport without replay',
);
assert.equal(recoveredInterrupted?.error, 'Agent run interrupted because the server restarted before provider state could be resumed.');
assert.equal(recoveredInterrupted?.events.at(-1)?.type, 'done');
const interruptedSidecar = await loadAgentRuntimeSidecar(interrupted.projectId);
const interruptedRecord = interruptedSidecar.runs.find(
  (item) => item.runId === interrupted.id,
);
assert.equal(interruptedRecord?.status, 'running');
assert.equal(interruptedRecord?.context?.transportStatus, 'failed');
assert.equal(interruptedRecord?.context?.transportError, recoveredInterrupted?.error);
resetServerRunStoreForTest();
const terminalStatusOnly = run('server-run-status-only-recovery');
pushRunEvent(terminalStatusOnly, 'status', {
  status: 'completed',
  error: null,
});
await flushRunPersistence(terminalStatusOnly);
resetServerRunStoreForTest();
const recoveredStatusOnly = await recoverServerRun(
  terminalStatusOnly.projectId,
  terminalStatusOnly.id,
);
assert.equal(
  recoveredStatusOnly?.status,
  'completed',
  'restart recovery infers terminal transport from a durable status event',
);
assert.equal(recoveredStatusOnly?.error, null);
assert.equal(recoveredStatusOnly?.events.at(-1)?.type, 'done');


// Event cap failure is terminal but must retain replayable status and done events.
const capped = run('server-run-cap');
for (let index = 0; index < MAX_SERVER_RUN_EVENTS; index += 1) pushRunEvent(capped, 'diagnostic', { index });
assert.throws(() => pushRunEvent(capped, 'overflow', {}), /event limit/i);
await capped.terminalPromise;
assert.equal(capped.status, 'failed');
assert.equal(capped.events.at(-2)?.type, 'status');
assert.equal(capped.events.at(-1)?.type, 'done');
const cappedDone = capped.events.at(-1)?.data;
assert(cappedDone && typeof cappedDone === 'object' && 'status' in cappedDone);
assert.equal(cappedDone.status, 'failed');
await flushServerRunPersistence(capped);
resetServerRunStoreForTest();
const recovered = await recoverServerRuns('server-run-cap');
assert.equal(recovered.find((item) => item.id === capped.id)?.events.at(-1)?.type, 'done', 'terminal done event replays after recovery');

// A tool result is a one-shot settlement. Re-delivery after a reconnect is a
// duplicate, not a second execution or a replacement of the accepted result.
const toolRun = run();
await setRunStatus(toolRun, 'running');
const argsDigest = digestToolArgs({ endFrame: 42, startFrame: 12 });
const toolResult = waitForToolResult(toolRun, 'call-1', 'trim_clip', argsDigest);
assert.equal(claimToolRequest(toolRun, { toolCallId: 'call-1', argsDigest, claimId: 'browser-1' }), 'claimed');
assert.equal(claimToolRequest(toolRun, { toolCallId: 'call-1', argsDigest, claimId: 'browser-1' }), 'duplicate');
assert.equal(claimToolRequest(toolRun, { toolCallId: 'call-1', argsDigest, claimId: 'browser-2' }), 'already-claimed');
assert.equal(settleToolResult(toolRun, {
  toolCallId: 'call-1', argsDigest, claimId: 'browser-1', result: { ok: true },
}), 'accepted');
assert.deepEqual(await toolResult, { ok: true });
assert.equal(settleToolResult(toolRun, {
  toolCallId: 'call-1', argsDigest, claimId: 'browser-1', result: { ok: true },
}), 'duplicate', 'an identical repeated tool result is idempotent');
assert.equal(settleToolResult(toolRun, {
  toolCallId: 'call-1', argsDigest, claimId: 'browser-1', result: { ok: false },
}), 'mismatch', 'a conflicting duplicate tool result is rejected');
assert.equal(settleToolResult(toolRun, {
  toolCallId: 'call-1', argsDigest: digestToolArgs({ endFrame: 99 }), claimId: 'browser-1', result: { ok: true },
}), 'mismatch', 'a result cannot settle a tool call with different arguments');
const abandonedRun = run('server-run-tool-timeout');
await setRunStatus(abandonedRun, 'running');
const abandonedDigest = digestToolArgs({ query: 'disconnected editor' });
await assert.rejects(
  waitForToolResult(
    abandonedRun,
    'call-timeout',
    'read_project',
    abandonedDigest,
    5,
  ),
  /tool request timed out/i,
  'a disconnected editor cannot park a server run forever',
);
assert.equal(claimToolRequest(abandonedRun, {
  toolCallId: 'call-timeout',
  argsDigest: abandonedDigest,
  claimId: 'late-browser',
}), 'run-settled');

const largeResult = {
  rows: Array.from({ length: 2_000 }, (_, index) => ({
    index,
    text: `row-${index}-${'x'.repeat(80)}`,
  })),
};
const largeDigest = digestToolArgs({ query: 'large' });
const largePromise = waitForToolResult(
  toolRun,
  'call-large',
  'search_templates',
  largeDigest,
);
assert.equal(claimToolRequest(toolRun, {
  toolCallId: 'call-large',
  argsDigest: largeDigest,
  claimId: 'browser-1',
}), 'claimed');
assert.equal(settleToolResult(toolRun, {
  toolCallId: 'call-large',
  argsDigest: largeDigest,
  claimId: 'browser-1',
  result: largeResult,
}), 'accepted');
assert.deepEqual(
  await largePromise,
  largeResult,
  'the provider receives the original in-memory result rather than its durable projection',
);
await flushRunPersistence(toolRun);
const largeEvent = toolRun.events.find((event) => {
  const data = event.data;
  return event.type === 'tool-result'
    && data !== null
    && typeof data === 'object'
    && 'toolCallId' in data
    && data.toolCallId === 'call-large';
});
assert(
  new TextEncoder().encode(JSON.stringify(largeEvent?.data)).byteLength < 20_000,
  'the replay event retains only the model-safe projection',
);

// Explicit stop must settle browser-bound work as well as aborting the provider;
// otherwise the durable executor remains parked forever on the tool promise.
const cancelled = run();
await setRunStatus(cancelled, 'running');
const cancelledDigest = digestToolArgs({ itemId: 'clip-1' });
const pendingTool = waitForToolResult(cancelled, 'call-cancel', 'delete_item', cancelledDigest);
await cancelRun(cancelled);
await assert.rejects(
  pendingTool,
  /cancel|stop|abort/i,
  'cancellation rejects a pending browser tool',
);
assert.equal(cancelled.status, 'cancelled');
assert.equal(
  cancelled.toolRequests.get('call-cancel')?.status,
  'cancelled',
  'cancellation settles the durable tool request record',
);

const metricsRun = run('server-run-metrics');
recordServerContextUsage(metricsRun, {
  inputTokens: 100,
  contextWindowTokens: 10_000,
  contextWindowEstimated: false,
  isEstimated: false,
  modelId: 'test-model',
  compacted: false,
  messageCount: 2,
  outputTokens: 5,
  reasoningTokens: 1,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  noCacheInputTokens: 70,
}, 6);
recordServerContextUsage(metricsRun, {
  inputTokens: 120,
  contextWindowTokens: 10_000,
  contextWindowEstimated: false,
  isEstimated: false,
  modelId: 'test-model',
  compacted: false,
  messageCount: 4,
  outputTokens: 7,
  reasoningTokens: 2,
  cacheReadTokens: 60,
  cacheWriteTokens: 0,
  noCacheInputTokens: 60,
}, 8);
await flushServerRunPersistence(metricsRun);
const metricsSidecar = await loadAgentRuntimeSidecar(metricsRun.projectId);
const metricsContext = metricsSidecar.runs.find(
  (item) => item.runId === metricsRun.id,
)?.context;
assert.equal(metricsContext?.modelRequestCount, 2);
assert.equal(metricsContext?.totalInputTokens, 220);
assert.equal(metricsContext?.totalFreshInputTokens, 130);
assert.equal(metricsContext?.totalCacheReadTokens, 80);
assert.equal(metricsContext?.totalCacheWriteTokens, 10);
assert.equal(metricsContext?.totalOutputTokens, 12);
assert.equal(metricsContext?.totalReasoningTokens, 3);

const checkpointRun = run('server-run-checkpoint');
const sourceText = 'sanitized prior conversation';
const sourceDigest = await sha256(sourceText);
const summary = 'User goal: continue the edit';
const summaryDigest = await sha256(summary);
await persistServerCheckpoint(checkpointRun, {
  checkpointId: 'checkpoint-server-run',
  summary,
  sourceText,
  sourceMessageCount: 12,
  sourceDigest,
  summaryDigest,
  createdAt: Date.now(),
});
await flushServerRunPersistence(checkpointRun);
const checkpointSidecar = await loadAgentRuntimeSidecar(checkpointRun.projectId);
const checkpoint = checkpointSidecar.checkpoints.find((item) => (
  item.checkpointId === 'checkpoint-server-run'
));
assert(checkpoint, 'server context compaction creates a durable checkpoint');
assert.equal(checkpoint?.sourceDigest, sourceDigest);
assert(checkpoint?.sourceArtifactId);
assert.equal(
  (await loadAgentArtifact(
    checkpointRun.projectId,
    checkpoint!.sourceArtifactId,
  ))?.body,
  sourceText,
  'the exact sanitized checkpoint source remains digest-verifiable',
);

resetServerRunStoreForTest();
const generationProject = 'server-run-generation-isolation';
const admittedGeneration = await prepareRunAdmission(generationProject);
assert.equal(
  admittedGeneration,
  await currentAgentSessionGeneration(generationProject),
  'run admission pins the fresh authoritative session generation',
);
const staleRun = createRun({
  projectId: generationProject,
  sessionGeneration: admittedGeneration,
  provider: 'deepseek',
  model: 'test-model',
});
await flushRunPersistence(staleRun);
const rotatedGeneration = await rotateAgentSessionGeneration(generationProject);
assert.notEqual(rotatedGeneration, admittedGeneration);
assert.equal(
  await recoverServerRun(generationProject, staleRun.id),
  undefined,
  'a clear-conversation generation change rejects the stale in-memory run',
);
assert.equal(
  getRun(staleRun.id),
  undefined,
  'generation rejection also evicts the stale map entry',
);
assert.equal(
  await prepareRunAdmission(generationProject),
  rotatedGeneration,
  'the next admission adopts the cleared session generation',
);

resetServerRunStoreForTest();
const boundedProject = 'server-run-bounded-terminal-history';
const boundedGeneration = await prepareRunAdmission(boundedProject);
const sequential: string[] = [];
for (let index = 0; index <= MAX_ACTIVE_SERVER_RUNS; index += 1) {
  const completed = createRun({
    projectId: boundedProject,
    sessionGeneration: boundedGeneration,
    provider: 'deepseek',
    model: 'test-model',
  });
  sequential.push(completed.id);
  await setRunStatus(completed, 'completed');
}
assert.equal(
  getRun(sequential[0]!),
  undefined,
  'sequential terminal runs prune the oldest in-memory transport',
);
assert(getRun(sequential.at(-1)!), 'the newest terminal transport remains replayable');

console.log('server agent run store verification passed');
