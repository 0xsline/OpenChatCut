// Every tool call adds a request and a result to a run's replay window, and
// neither rolls off the way text does. A long turn used to reach the hard
// ceiling and fail with "Agent run event limit/replay retention limit
// reached." Past the ceiling the oldest finished calls now retire instead.
import assert from 'node:assert/strict';
import { resetAgentRuntimeStoreMemory } from '../../src/persist/agentRuntimeStore.ts';
import { resetSharedKvMemory } from '../../src/persist/sharedKv.ts';
import {
  cancelRun,
  createRun,
  digestToolArgs,
  flushRunPersistence,
  MAX_SERVER_RUN_BYTES,
  MAX_SERVER_RUN_EVENTS,
  pushRunEvent,
  recoverServerRun,
  resetServerRunStoreForTest,
  setRunStatus,
  waitForToolResult,
  type ServerRun,
  type ServerRunEvent,
} from './store.ts';

resetServerRunStoreForTest();
resetAgentRuntimeStoreMemory();
resetSharedKvMemory();

const HARD_EVENTS = MAX_SERVER_RUN_EVENTS * 4;
const HARD_BYTES = MAX_SERVER_RUN_BYTES * 4;
const callIdOf = (event: ServerRunEvent): unknown => (event.data as { toolCallId?: unknown }).toolCallId;

function newRun(projectId: string): ServerRun {
  return createRun({ projectId, sessionGeneration: 'legacy', provider: 'deepseek', model: 'test-model' });
}

function pushFinishedCall(run: ServerRun, index: number, result: unknown): void {
  const toolCallId = `call-${index}`;
  const argsDigest = digestToolArgs({ index });
  pushRunEvent(run, 'tool-request', { toolCallId, name: 'read_timeline', args: { index }, argsDigest });
  pushRunEvent(run, 'tool-result', { toolCallId, toolName: 'read_timeline', argsDigest, result });
}

function assertWindow(run: ServerRun, label: string, lastCall: number): void {
  assert.equal(run.status, 'running', `${label}: the run keeps running`);
  assert.equal(run.error, null, `${label}: no event-limit error`);
  assert.ok(run.events.length <= HARD_EVENTS, `${label}: ${run.events.length} events fit the ceiling`);
  assert.ok(run.retainedEventBytes <= HARD_BYTES, `${label}: ${run.retainedEventBytes} bytes fit the ceiling`);
  assert.equal(run.events[0]?.type, 'status', `${label}: the first event still anchors replay`);
  assert.equal(run.replayStart, run.events[0]?.id, `${label}: a reconnect from an old cursor still replays`);
  assert.ok(run.events.some((event) => event.type === 'tool-request' && callIdOf(event) === 'call-pending'),
    `${label}: a request the browser may still claim never retires`);
  assert.ok(!run.events.some((event) => callIdOf(event) === 'call-0'), `${label}: the oldest finished call retired`);
  assert.equal(run.events.filter((event) => callIdOf(event) === `call-${lastCall}`).length, 2,
    `${label}: the newest call keeps its request and result`);
  const requests = new Set(run.events.filter((event) => event.type === 'tool-request').map(callIdOf));
  assert.ok(run.events.filter((event) => event.type === 'tool-result').every((event) => requests.has(callIdOf(event))),
    `${label}: a call retires together with its result`);
}

// Returned in an object: an async function would otherwise wait for the call to settle.
async function startWithPendingCall(run: ServerRun): Promise<{ pending: Promise<unknown> }> {
  await setRunStatus(run, 'running');
  const argsDigest = digestToolArgs({ scope: 'pending' });
  const pending = waitForToolResult(run, 'call-pending', 'read_project', argsDigest);
  pushRunEvent(run, 'tool-request', { toolCallId: 'call-pending', name: 'read_project', args: { scope: 'pending' }, argsDigest });
  return { pending };
}

// Count: twice as many events as the ceiling.
const counted = newRun('server-run-event-window-count');
const { pending: countedPending } = await startWithPendingCall(counted);
for (let index = 0; index < HARD_EVENTS; index += 1) pushFinishedCall(counted, index, { index });
await flushRunPersistence(counted);
assertWindow(counted, 'event count', HARD_EVENTS - 1);

// Bytes: large results pass the byte ceiling long before the count one.
const heavy = newRun('server-run-event-window-bytes');
const { pending: heavyPending } = await startWithPendingCall(heavy);
const heavyCalls = Math.ceil((HARD_BYTES * 1.5) / 30_000);
for (let index = 0; index < heavyCalls; index += 1) pushFinishedCall(heavy, index, { text: 'x'.repeat(30_000) });
await flushRunPersistence(heavy);
assertWindow(heavy, 'event bytes', heavyCalls - 1);

// Settlement still lands after a long window and replays after recovery.
await cancelRun(counted);
await assert.rejects(countedPending, /cancel/i);
await cancelRun(heavy);
await assert.rejects(heavyPending, /cancel/i);
await flushRunPersistence(counted);
resetServerRunStoreForTest();
const recovered = await recoverServerRun(counted.projectId, counted.id);
assert.equal(recovered?.status, 'cancelled', 'the settled status survives recovery');
assert.equal(recovered?.events.at(-1)?.type, 'done', 'the terminal done event replays after recovery');

console.log(`store-event-window.verify: ${HARD_EVENTS} finished calls and ${heavyCalls} large results keep the run going within the ceiling`);
