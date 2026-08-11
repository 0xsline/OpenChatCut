import assert from 'node:assert/strict';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore.ts';
import {
  createRunWithCapability,
  createRunWithPresentedCapability,
  createServerRunCapability,
  flushServerRunPersistence,
  resetServerRunStoreForTest,
  verifyServerRunCapability,
} from './store.ts';
import { serverRunCapabilityVerifier } from './store-values.ts';

const first = createServerRunCapability();
const second = createServerRunCapability();
assert.notEqual(first.capability, second.capability);
assert.equal(Buffer.from(first.capability, 'base64url').length, 32);
assert.equal(first.verifier, serverRunCapabilityVerifier(first.capability));
assert(verifyServerRunCapability(first.verifier, first.capability));
assert(!verifyServerRunCapability(first.verifier, second.capability));
assert(!verifyServerRunCapability(first.verifier, null));
assert(!verifyServerRunCapability('invalid', first.capability));

const created = createRunWithCapability({
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-capability-verifier',
  sessionGeneration: 'legacy',
  provider: 'deepseek',
  model: 'test',
});
assert.equal(
  created.run.runtimeContext.serverRunCapabilityVerifier,
  serverRunCapabilityVerifier(created.capability),
);
assert.equal(created.run.capabilityVerifier, created.run.runtimeContext.serverRunCapabilityVerifier);
assert(!JSON.stringify(created.run).includes(created.capability), 'the server run stores no plaintext bearer');
await flushServerRunPersistence(created.run);
const sidecar = await loadAgentRuntimeSidecar(created.run.projectId);
const persisted = sidecar.runs.find((record) => record.runId === created.run.id);
assert.equal(
  persisted?.context?.serverRunCapabilityVerifier,
  created.run.capabilityVerifier,
);
assert(!JSON.stringify(persisted).includes(created.capability), 'the sidecar stores no plaintext bearer');
const presentedCapability = 'c'.repeat(43);
const presented = createRunWithPresentedCapability({
  id: '22222222-2222-4222-8222-222222222222',
  projectId: 'project-presented-capability',
  sessionGeneration: 'legacy',
  provider: 'deepseek',
  model: 'test',
}, presentedCapability);
assert.equal(presented.capability, presentedCapability);
assert.equal(
  presented.run.capabilityVerifier,
  serverRunCapabilityVerifier(presentedCapability),
  'the server derives only the verifier from the browser-persisted bearer',
);
assert.throws(
  () => createRunWithPresentedCapability({
    id: '33333333-3333-4333-8333-333333333333',
    projectId: 'project-invalid-presented-capability',
    sessionGeneration: 'legacy',
    provider: 'deepseek',
    model: 'test',
  }, 'not-a-capability'),
  /Invalid Agent run capability/,
);
resetServerRunStoreForTest();

console.log('server run capability verification passed');
