import assert from 'node:assert/strict';
import {
  connectedProjectIds,
  isProjectConnected,
  invokeEditorTool,
  nextEditorCall,
  onRegisteredToolsChanged,
  registerEditor,
  resolveProjectId,
  settleEditorCall,
} from './broker.ts';

const projectId = 'project-check';
const editorId = 'editor-check';
let toolChanges = 0;
const stopWatchingTools = onRegisteredToolsChanged(() => { toolChanges += 1; });
registerEditor(projectId, editorId, [{
  name: 'read_timeline',
  input_schema: { type: 'object', properties: {} },
}]);
assert.equal(toolChanges, 1, 'first editor registration announces the expanded tool list');
registerEditor(projectId, editorId, [{
  name: 'read_timeline',
  input_schema: { type: 'object', properties: {} },
}]);
assert.equal(toolChanges, 1, 'heartbeats with the same schemas do not spam list-changed');
stopWatchingTools();
assert.deepEqual(connectedProjectIds(), [projectId]);
assert.equal(resolveProjectId(undefined), projectId);

const resultPromise = invokeEditorTool(projectId, 'read_timeline', {});
const call = await nextEditorCall(projectId, editorId, new AbortController().signal);
assert.equal(call?.name, 'read_timeline');
assert.equal(isProjectConnected(projectId, Date.now() + 60_000), true, 'in-flight calls keep a busy editor connected');
assert.equal(settleEditorCall(call!.id, true, { fps: 30 }), true);
assert.equal(isProjectConnected(projectId, Date.now() + 60_000), false, 'settled calls no longer mask an offline editor');
assert.deepEqual(await resultPromise, { fps: 30 });
await import('./mcp.verify.ts');
console.log('external-agent broker check passed');
