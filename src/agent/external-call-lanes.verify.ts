import assert from 'node:assert/strict';
import {
  EXTERNAL_FAST_LANE_TOOLS,
  ExternalCallLanes,
  externalCallLane,
  raceAbort,
} from './external-call-lanes';
import { ExternalCallCancellationRegistry } from './external-call-cancellation';
import { ExternalEditSessionOutcomeError, type ExternalEditSessionTerminalStatus } from './external-edit-session';
import { executeExternalCall } from './useExternalAgentBridge';
import type { ExternalBridgeBinding } from './external-bridge-runtime';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Lane keys: session-management tools never queue; draft tools serialize per session.
for (const name of EXTERNAL_FAST_LANE_TOOLS) {
  assert.equal(externalCallLane({ id: name, name, arguments: { editSessionId: 's1' } }), null,
    `${name} runs without queueing behind a busy call`);
}
assert.equal(externalCallLane({ id: 'a', name: 'edit_item', arguments: { editSessionId: 's1' } }), 'session:s1');
assert.equal(externalCallLane({ id: 'b', name: 'read_project', arguments: {} }), 'shared');

// Within one lane tasks run strictly in order; across lanes they overlap.
{
  const lanes = new ExternalCallLanes();
  const order: string[] = [];
  const first = Promise.withResolvers<void>();
  void lanes.run('session:s1', async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
  void lanes.run('session:s1', async () => { order.push('b'); });
  void lanes.run('session:s2', async () => { order.push('c'); });
  await tick();
  assert.deepEqual(order, ['a:start', 'c'], 'a second lane is not blocked by the first lane');
  first.resolve();
  await lanes.drain();
  assert.deepEqual(order, ['a:start', 'c', 'a:end', 'b'], 'the same lane keeps call order');
  assert.equal(lanes.size, 0);
}

// A failed task does not poison its lane.
{
  const lanes = new ExternalCallLanes();
  const ran: string[] = [];
  await assert.rejects(lanes.run('shared', async () => { throw new Error('boom'); }), /boom/);
  await lanes.run('shared', async () => { ran.push('after'); });
  assert.deepEqual(ran, ['after']);
}

// A hung draft tool no longer blocks session-management tools (the original incident).
{
  const lanes = new ExternalCallLanes();
  const hung = Promise.withResolvers<void>();
  void lanes.run(externalCallLane({ id: 'x', name: 'import_asset', arguments: { editSessionId: 's1' } }),
    () => hung.promise);
  let listed = false;
  await lanes.run(externalCallLane({ id: 'y', name: 'list_edit_sessions', arguments: {} }),
    async () => { listed = true; });
  assert.equal(listed, true, 'list_edit_sessions completes while import_asset is still pending');
  hung.resolve();
  await lanes.drain();
}

// raceAbort settles on abort even when the task ignores its signal.
{
  const controller = new AbortController();
  const never = new Promise<never>(() => undefined);
  const raced = raceAbort(never, controller.signal, () => new Error('cancelled now'));
  controller.abort('timeout');
  await assert.rejects(raced, /cancelled now/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(raceAbort(Promise.resolve(1), aborted.signal, () => new Error('pre-aborted')), /pre-aborted/);
  assert.equal(await raceAbort(Promise.resolve(2), new AbortController().signal, () => new Error('x')), 2);
}

// executeExternalCall reports a cancelled call promptly even when the runtime never settles.
{
  const binding: ExternalBridgeBinding = { projectId: 'p', editorInstanceId: 'e', baseRevision: 'r' };
  const cancellations = new ExternalCallCancellationRegistry();
  const delivered: Array<{ outcome: ExternalEditSessionTerminalStatus; value: unknown }> = [];
  const bridge = new AbortController();
  const pending = executeExternalCall(
    { id: 'hung-call', name: 'view_timeline_frames', arguments: { editSessionId: 's1' }, binding },
    { execute: () => new Promise<never>(() => undefined) },
    bridge.signal,
    cancellations,
    async (_id, outcome, value) => { delivered.push({ outcome, value }); },
  );
  await tick();
  cancellations.cancel('hung-call', 'OpenChatCut tool view_timeline_frames timed out.');
  await pending;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].outcome, 'cancelled');
  assert.match(String(delivered[0].value), /timed out/);
  assert.ok(new ExternalEditSessionOutcomeError('cancelled', 'x') instanceof Error);
}

console.log('external call lanes: fast lane, per-session order, abort release passed');
