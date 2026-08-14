import assert from 'node:assert/strict';
import {
  cancelEditorCallsForOwner,
  connectedProjectIds,
  editorBinding,
  editorStatuses,
  ExternalEditorCallError,
  invokeEditorTool,
  isProjectConnected,
  nextEditorCall,
  nextEditorCancellation,
  onRegisteredToolsChanged,
  pendingEditorCallsForTest,
  registerEditor,
  resetExternalAgentBrokerForTest,
  settleEditorCall,
  unregisterEditor,
} from './broker.ts';

const projectId = 'project-check';
const editorId = 'editor-check';
const revision = 'v1-project-check';
const tools = [{
  name: 'read_timeline',
  input_schema: { type: 'object' as const, properties: {} },
}];

function hasOutcome(outcome: ExternalEditorCallError['outcome']): (error: unknown) => boolean {
  return (error) => error instanceof ExternalEditorCallError && error.outcome === outcome;
}

resetExternalAgentBrokerForTest();
let toolChanges = 0;
const stopWatchingTools = onRegisteredToolsChanged(() => { toolChanges += 1; });
let registrationCapability = registerEditor(projectId, editorId, revision, tools, undefined, null);
assert.match(registrationCapability, /^[A-Za-z0-9_-]{43}$/);
assert.equal(toolChanges, 1, 'first editor registration announces the expanded tool list');
assert.throws(
  () => registerEditor(projectId, editorId, revision, tools, undefined, 'w'.repeat(43)),
  hasOutcome('stale'),
  'a client that only knows the public editor id cannot renew its registration',
);
assert.equal(
  registerEditor(projectId, editorId, revision, tools, undefined, registrationCapability),
  registrationCapability,
  'the owning editor can renew without rotating its live capability',
);
assert.equal(toolChanges, 1, 'heartbeats with the same schemas do not spam list-changed');
stopWatchingTools();
assert.deepEqual(connectedProjectIds(), [projectId]);

const binding = editorBinding(projectId);
assert(binding);
assert.equal(JSON.stringify(editorStatuses()).includes(registrationCapability), false,
  'registration capabilities are never exposed through editor status');
const resultPromise = invokeEditorTool('owner-success', binding, 'read_timeline', {});
const call = await nextEditorCall(
  projectId,
  editorId,
  revision,
  new AbortController().signal,
  registrationCapability,
);
assert(call);
assert.equal(call.name, 'read_timeline');
assert.deepEqual(call.binding, binding);
assert.equal(isProjectConnected(projectId, Date.now() + 60_000), true, 'in-flight calls keep a busy editor connected');
assert.equal(settleEditorCall(call.id, 'applied', { fps: 30 }, registrationCapability), true);
assert.equal(isProjectConnected(projectId, Date.now() + 60_000), false, 'settled calls no longer mask an offline editor');
assert.deepEqual(await resultPromise, { fps: 30 });

const inFlightPromise = invokeEditorTool('owner-evicted', binding, 'read_timeline', {});
const inFlight = await nextEditorCall(
  projectId,
  editorId,
  revision,
  new AbortController().signal,
  registrationCapability,
);
assert(inFlight);
assert.equal(cancelEditorCallsForOwner('owner-evicted'), 1);
await assert.rejects(inFlightPromise, hasOutcome('cancelled'));
const cancellation = await nextEditorCancellation(
  projectId,
  editorId,
  AbortSignal.timeout(100),
  registrationCapability,
);
assert.equal(cancellation?.id, inFlight.id, 'in-flight cancellation is delivered cooperatively to the editor');
assert.equal(cancellation?.outcome, 'cancelled');
assert.equal(settleEditorCall(inFlight.id, 'applied', { late: true }), false, 'late mutation results cannot revive a cancelled call');

const queuedPromise = invokeEditorTool('owner-project-close', binding, 'read_timeline', {});
assert.equal(await unregisterEditor(projectId, editorId, 'w'.repeat(43)), false);
assert.equal(await unregisterEditor(projectId, editorId, registrationCapability), true);
await assert.rejects(queuedPromise, hasOutcome('cancelled'));
assert.equal(pendingEditorCallsForTest().length, 0, 'project close settles queued calls instead of leaving them pending');

registrationCapability = registerEditor(projectId, editorId, revision, tools, undefined, null);
const staleBinding = editorBinding(projectId);
assert(staleBinding);
const stalePromise = invokeEditorTool('owner-stale', staleBinding, 'read_timeline', {});
registerEditor(projectId, editorId, 'v2-project-check', tools, undefined, registrationCapability);
await assert.rejects(stalePromise, hasOutcome('stale'));
assert.equal(pendingEditorCallsForTest().length, 0, 'revision changes remove stale calls from the dequeue path');
// Same-editor revision advance now adopts the registry's current binding
// instead of rejecting the call (autosave/registry-sync progression is
// legitimate, not a stale takeover). The adopted call runs normally.
const adoptedPromise = invokeEditorTool('owner-old-binding', staleBinding, 'read_timeline', {});
adoptedPromise.catch(() => undefined);
assert.equal(pendingEditorCallsForTest().length, 1, 'adopted call is queued');
const adopted = pendingEditorCallsForTest()[0];
assert.notEqual(adopted, undefined);

await import('./mcp.verify.ts');
await import('./broker-poll-refresh.verify.ts');
console.log('external-agent broker check passed');
