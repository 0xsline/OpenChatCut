import assert from 'node:assert/strict';
import { mock } from 'node:test';
import {
  isProjectConnected,
  nextEditorCall,
  registerEditor,
  resetExternalAgentBrokerForTest,
} from './broker.ts';

const projectId = 'project-poll-refresh';
const editorId = 'editor-poll-refresh';
const revision = 'v1-poll-refresh';
const tools = [{
  name: 'read_timeline',
  input_schema: { type: 'object' as const, properties: {} },
}];

resetExternalAgentBrokerForTest();
mock.timers.enable({ apis: ['Date', 'setTimeout'] });
try {
  const registrationCapability = registerEditor(projectId, editorId, revision, tools, undefined, null);
  const poll = nextEditorCall(
    projectId,
    editorId,
    revision,
    new AbortController().signal,
    registrationCapability,
  );

  // Let each refresh segment run before advancing to the next one. The final
  // 40-second observation distinguishes the refreshed lease from the old
  // single 25-second wait, which would leave lastSeen at time zero.
  await Promise.resolve();
  mock.timers.tick(8_000);
  await Promise.resolve();
  mock.timers.tick(8_000);
  await Promise.resolve();
  mock.timers.tick(8_000);
  await Promise.resolve();
  mock.timers.tick(1_000);
  assert.equal(await poll, null, 'an idle long-poll ends after its budget');
  mock.timers.setTime(40_000);
  assert.equal(
    isProjectConnected(projectId),
    true,
    'a long-poll refreshes lastSeen before the editor online lease expires',
  );
} finally {
  mock.timers.reset();
  resetExternalAgentBrokerForTest();
}

console.log('broker-poll-refresh.verify: ok');
