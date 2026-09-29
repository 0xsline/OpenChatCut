// A server run makes as many browser tool calls as its turn needs (#186). The
// store used to refuse the 101st request after the browser had already been
// told about it; the browser's claim then 404'd and it abandoned the run.
import assert from 'node:assert/strict';
import { ToolActivation } from '../../src/agent/tool-activation.ts';
import { ToolFailureTracker } from '../../src/agent/toolFailure.ts';
import { resetAgentRuntimeStoreMemory } from '../../src/persist/agentRuntimeStore.ts';
import { resetSharedKvMemory } from '../../src/persist/sharedKv.ts';
import { createAcceptanceLoop } from './acceptance-loop.ts';
import { executeBrowserTool, type ActivationState } from './executor.ts';
import {
  cancelRun,
  claimToolRequest,
  createRun,
  digestToolArgs,
  flushRunPersistence,
  registerToolRequest,
  resetServerRunStoreForTest,
  setRunStatus,
  settleToolResult,
  type ServerRun,
} from './store.ts';
import { canonicalServerRunToolCatalog } from './tool-policy.ts';

resetServerRunStoreForTest();
resetAgentRuntimeStoreMemory();
resetSharedKvMemory();

const catalog = canonicalServerRunToolCatalog(false);
const readProject = catalog.find((schema) => schema.name === 'read_project');
assert(readProject, 'read_project is in the edit catalog');
const argsDigest = digestToolArgs({});

function newRun(projectId: string): ServerRun {
  return createRun({ projectId, sessionGeneration: 'legacy', provider: 'deepseek', model: 'test-model' });
}

function newActivation(): ActivationState {
  return {
    current: new ToolActivation(catalog, []),
    tail: Promise.resolve(),
    followupText: null,
    toolFailures: new ToolFailureTracker(),
    acceptance: createAcceptanceLoop(false, 3),
  };
}

async function untilRegistered(run: ServerRun, toolCallId: string): Promise<void> {
  for (let tick = 0; tick < 50 && !run.toolRequests.has(toolCallId); tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert(run.toolRequests.has(toolCallId), `${toolCallId} is registered`);
}

function announced(run: ServerRun, toolCallId: string): number {
  return run.events.filter((event) => event.type === 'tool-request'
    && (event.data as { toolCallId?: unknown }).toolCallId === toolCallId).length;
}

// Well past the old 100-call cap, every request is claimable and settles.
const longRun = newRun('server-run-long-turn');
await setRunStatus(longRun, 'running');
const longActivation = newActivation();
const CALLS = 250;
for (let index = 0; index < CALLS; index += 1) {
  const toolCallId = `call-${index}`;
  const pending = executeBrowserTool(longRun, readProject, {}, toolCallId, longActivation);
  await untilRegistered(longRun, toolCallId);
  assert.equal(claimToolRequest(longRun, { toolCallId, argsDigest, claimId: 'browser' }), 'claimed',
    `call ${index + 1} can be claimed`);
  assert.equal(settleToolResult(longRun, { toolCallId, argsDigest, claimId: 'browser', result: { index } }),
    'accepted', `call ${index + 1} settles`);
  assert.equal((await pending as { index?: unknown }).index, index, `call ${index + 1} delivers its result`);
}
await flushRunPersistence(longRun);
assert.equal(longRun.status, 'running', 'the run is still running after all calls');
assert.equal(claimToolRequest(longRun, { toolCallId: 'call-0', argsDigest, claimId: 'browser' }), 'run-settled',
  'an early settled call still answers a late claim');
assert.equal(settleToolResult(longRun, {
  toolCallId: 'call-0', argsDigest, claimId: 'browser', result: { index: 0 },
}), 'duplicate', 'an early settled call still recognises a re-sent result');
const settled = longRun.toolRequests.get('call-0');
assert.equal(settled?.timeout, undefined, 'a settled request holds no timer');

// A request the store refuses is never announced to the browser.
const duplicateRun = newRun('server-run-duplicate-call');
await setRunStatus(duplicateRun, 'running');
const duplicateActivation = newActivation();
const first = executeBrowserTool(duplicateRun, readProject, {}, 'call-dup', duplicateActivation);
await untilRegistered(duplicateRun, 'call-dup');
await assert.rejects(
  executeBrowserTool(duplicateRun, readProject, {}, 'call-dup', duplicateActivation),
  /Duplicate toolCallId/,
);
assert.equal(claimToolRequest(duplicateRun, { toolCallId: 'call-dup', argsDigest, claimId: 'browser' }), 'claimed');
assert.equal(settleToolResult(duplicateRun, {
  toolCallId: 'call-dup', argsDigest, claimId: 'browser', result: { ok: true },
}), 'accepted');
await first;
await flushRunPersistence(duplicateRun);
assert.equal(announced(duplicateRun, 'call-dup'), 1, 'the refused duplicate was not announced');

// Two identical calls in one step are two operations. Their pending approval
// mirrors used to collide as one duplicated approval and fail the run.
const parallelRun = newRun('server-run-identical-parallel');
await setRunStatus(parallelRun, 'running');
const parallelActivation = newActivation();
const left = executeBrowserTool(parallelRun, readProject, {}, 'call-left', parallelActivation);
const right = executeBrowserTool(parallelRun, readProject, {}, 'call-right', parallelActivation);
await untilRegistered(parallelRun, 'call-left');
await untilRegistered(parallelRun, 'call-right');
await flushRunPersistence(parallelRun);
assert.equal(parallelRun.status, 'running', 'identical parallel calls keep the run running');
for (const toolCallId of ['call-left', 'call-right']) {
  assert.equal(claimToolRequest(parallelRun, { toolCallId, argsDigest, claimId: 'browser' }), 'claimed');
  assert.equal(settleToolResult(parallelRun, {
    toolCallId, argsDigest, claimId: 'browser', result: { toolCallId },
  }), 'accepted');
}
assert.deepEqual(await Promise.all([left, right]).then((results) => results.map((result) => (
  (result as { toolCallId?: unknown }).toolCallId))), ['call-left', 'call-right']);
await flushRunPersistence(parallelRun);

// Once a run starts settling, it takes no new requests: they could never be served.
const settlingRun = newRun('server-run-settling');
await setRunStatus(settlingRun, 'running');
const cancelling = cancelRun(settlingRun);
assert.notEqual(settlingRun.status, 'cancelled', 'settlement is still in progress');
assert.throws(
  () => registerToolRequest(settlingRun, 'call-late', 'read_project', argsDigest),
  /already settled/,
);
await cancelling;
await assert.rejects(
  executeBrowserTool(settlingRun, readProject, {}, 'call-after', newActivation()),
  /already settled/,
);
assert.equal(announced(settlingRun, 'call-after'), 0, 'a request refused after settlement is not announced');

console.log(`store-tool-requests.verify: ${CALLS} calls in one run all settle; identical parallel calls both run; refused requests are never announced`);
