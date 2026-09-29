// Every tool call adds a request and a result to a run's replay window. Only
// text and diagnostics used to leave a full window, so a long turn filled it
// with tool events: after about 96 calls each new text delta was dropped on
// arrival, and past four times the window the run failed with "Agent run
// event limit/replay retention limit reached." Finished calls now leave the
// window by age like text does, and the run keeps going.
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

// Returned in an object: an async function would otherwise wait for the call to settle.
async function startWithPendingCall(run: ServerRun): Promise<{ pending: Promise<unknown> }> {
  await setRunStatus(run, 'running');
  const argsDigest = digestToolArgs({ scope: 'pending' });
  const pending = waitForToolResult(run, 'call-pending', 'read_project', argsDigest);
  pushRunEvent(run, 'tool-request', { toolCallId: 'call-pending', name: 'read_project', args: { scope: 'pending' }, argsDigest });
  return { pending };
}

function assertWindow(run: ServerRun, label: string, lastCall: number): void {
  assert.equal(run.status, 'running', `${label}: the run keeps running`);
  assert.equal(run.error, null, `${label}: no event-limit error`);
  assert.ok(run.events.length <= MAX_SERVER_RUN_EVENTS, `${label}: ${run.events.length} events fit the window`);
  assert.ok(run.retainedEventBytes <= MAX_SERVER_RUN_BYTES, `${label}: ${run.retainedEventBytes} bytes fit the window`);
  assert.equal(run.events[0]?.type, 'status', `${label}: the first event still anchors replay`);
  assert.equal(run.replayStart, run.events[0]?.id, `${label}: a reconnect from an old cursor still replays`);
  assert.ok(run.events.some((event) => event.type === 'tool-request' && callIdOf(event) === 'call-pending'),
    `${label}: a request the browser may still claim never leaves`);
  assert.ok(!run.events.some((event) => callIdOf(event) === 'call-0'), `${label}: the oldest finished call left`);
  assert.equal(run.events.filter((event) => callIdOf(event) === `call-${lastCall}`).length, 2,
    `${label}: the newest call keeps its request and result`);
  const requests = new Set(run.events.filter((event) => event.type === 'tool-request').map(callIdOf));
  assert.ok(run.events.filter((event) => event.type === 'tool-result').every((event) => requests.has(callIdOf(event))),
    `${label}: a call leaves together with its result`);
}

// Count: four times as many finished calls as the window holds events.
const counted = newRun('server-run-event-window-count');
const { pending: countedPending } = await startWithPendingCall(counted);
const CALLS = MAX_SERVER_RUN_EVENTS * 4;
for (let index = 0; index < CALLS; index += 1) pushFinishedCall(counted, index, { index });
await flushRunPersistence(counted);
assertWindow(counted, 'event count', CALLS - 1);

// Text after a window full of tool calls reaches subscribers instead of being
// dropped on arrival.
for (let index = 0; index < 5; index += 1) pushRunEvent(counted, 'text-delta', { delta: `word ${index} ` });
await flushRunPersistence(counted);
assert.deepEqual(
  counted.events.slice(-5).map((event) => (event.data as { delta?: unknown }).delta),
  ['word 0 ', 'word 1 ', 'word 2 ', 'word 3 ', 'word 4 '],
  'every text delta after a long run of tool calls stays in the window',
);

// Bytes: large results fill the byte budget long before the count.
const heavy = newRun('server-run-event-window-bytes');
const { pending: heavyPending } = await startWithPendingCall(heavy);
const heavyCalls = Math.ceil((MAX_SERVER_RUN_BYTES * 4) / 30_000);
for (let index = 0; index < heavyCalls; index += 1) pushFinishedCall(heavy, index, { text: 'x'.repeat(30_000) });
await flushRunPersistence(heavy);
assertWindow(heavy, 'event bytes', heavyCalls - 1);

// Settlement makes room the same way, so the replay anchor survives it.
const anchor = counted.events[0]?.id;
await cancelRun(counted);
await assert.rejects(countedPending, /cancel/i);
await cancelRun(heavy);
await assert.rejects(heavyPending, /cancel/i);
await flushRunPersistence(counted);
assert.equal(counted.events[0]?.id, anchor, 'settlement keeps the replay anchor');
assert.equal(counted.replayStart, anchor, 'an old cursor still replays to the terminal events');
assert.equal(counted.events.at(-1)?.type, 'done');
resetServerRunStoreForTest();
const recovered = await recoverServerRun(counted.projectId, counted.id);
assert.equal(recovered?.status, 'cancelled', 'the settled status survives recovery');
assert.equal(recovered?.events.at(-1)?.type, 'done', 'the terminal done event replays after recovery');

console.log(`store-event-window.verify: ${CALLS} finished calls and ${heavyCalls} large results keep the run and its text going within the window`);
