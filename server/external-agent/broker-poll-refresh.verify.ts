import assert from 'node:assert/strict';
import { mock } from 'node:test';
import {
  isProjectConnected,
  nextEditorCall,
  registerEditor,
  resetExternalAgentBrokerForTest,
  touchEditor,
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

// Direct-touch scenario: bridge routes touch the editor outside the long-poll
// wait loop (poll entry, tool settle). A validated touch must refresh the
// online lease too, or an idle editor drops out of isConnected() after
// ONLINE_MS while its registration still blocks the offline fallback.
resetExternalAgentBrokerForTest();
mock.timers.enable({ apis: ['Date', 'setTimeout'] });
try {
  const registrationCapability = registerEditor(projectId, editorId, revision, tools, undefined, null);
  mock.timers.setTime(30_000);
  assert.equal(
    await touchEditor(projectId, editorId, revision, registrationCapability),
    true,
    'touch accepts the registered editor',
  );
  mock.timers.setTime(60_000);
  assert.equal(
    isProjectConnected(projectId),
    true,
    'a validated touch refreshes the editor online lease',
  );
} finally {
  mock.timers.reset();
  resetExternalAgentBrokerForTest();
}

console.log('broker-poll-refresh.verify: ok');
