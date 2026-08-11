import assert from 'node:assert/strict';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory,
} from '../persist/agentRuntimeStore.ts';
import { startAgentRun } from './runtime-ledger.ts';
import { saveServerRunDraftTool } from './serverRunDraftStore.ts';

const projectId = `server-run-draft-privacy-${Date.now()}`;
resetAgentRuntimeStoreMemory();
const recorder = await startAgentRun({
  projectId,
  userInput: 'download private media',
  askOnly: false,
});
await saveServerRunDraftTool(projectId, recorder.runId, {
  toolCallId: 'call-private-download',
  argsDigest: 'digest-private-download',
  name: 'download_media',
  args: {
    url: 'https://s3.example/private.mp4?X-Amz-Credential=AKIA_TEST&X-Amz-Signature=aws-secret&X-Amz-Expires=900',
    nested: { apiKey: 'nested-secret' },
    azure: 'https://blob.example/private.mp4?sv=2024-01-01&se=2030-01-01&sp=r&sig=azure-secret',
    gcs: 'https://storage.example/private.mp4?X-Goog-Credential=test&X-Goog-Signature=gcs-secret',
  },
  error: 'Authorization: Bearer tool-error-secret',
  actions: [],
});
const sidecar = await loadAgentRuntimeSidecar(projectId);
const index = sidecar.artifacts.find((artifact) => artifact.kind === 'server-run-draft');
assert(index, 'server-run recovery draft is indexed');
assert.equal(index.redacted, true);
assert.equal(index.binaryOmitted, false);
const artifact = await loadAgentArtifact(projectId, index.artifactId);
assert(artifact, 'server-run recovery draft body is readable');
assert.doesNotMatch(
  artifact.body,
  /AKIA_TEST|aws-secret|nested-secret|azure-secret|gcs-secret|tool-error-secret/,
);
assert.match(artifact.body, /\[REDACTED\]/);
const body = JSON.parse(artifact.body) as {
  args: { nested: { apiKey: string }; url: string; azure: string; gcs: string };
  error: string;
};
assert.equal(body.args.nested.apiKey, '[REDACTED]');
assert.match(body.args.url, /X-Amz-Signature=\[REDACTED\]/);
assert.match(body.args.azure, /sig=\[REDACTED\]/);
assert.match(body.args.gcs, /X-Goog-Signature=\[REDACTED\]/);
assert.match(body.error, /\[REDACTED\]/);
await recorder.finalize('interrupted', 'privacy verifier complete');

console.log('serverRunDraftStore.verify: recovery drafts redact credentials');
