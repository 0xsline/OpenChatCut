import assert from 'node:assert/strict';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory,
  storeAgentArtifact,
} from '../persist/agentRuntimeStore.ts';
import { startAgentRun } from './runtime-ledger.ts';
import { saveServerRunDraftTool } from './serverRunDraftStore.ts';

// The draft endpoint is server-side; emulate it with a local artifact write.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/draft/clear') && init?.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/draft') && init?.method === 'POST') {
    if (url.includes('draft-cap-403')) return new Response('{}', { status: 403 });
    if (url.includes('draft-gone-404')) return new Response('{}', { status: 404 });
    if (url.includes('draft-other-500')) return new Response('{}', { status: 500 });
    const body = JSON.parse(String(init.body)) as {
      projectId: string; artifact: Record<string, unknown>;
    };
    const a = body.artifact;
    await storeAgentArtifact({
      version: 1,
      artifactId: String(a.artifactId),
      projectId: body.projectId,
      runId: String(url).split('/').filter(Boolean).at(-2) ?? '',
      kind: 'server-run-draft',
      bodySha256: String(a.bodySha256),
      originalBytes: Number(a.originalBytes),
      originalChars: Number(a.originalChars),
      createdAt: Date.now(),
      redacted: a.redacted === true,
      binaryOmitted: a.binaryOmitted === true,
      body: String(a.body),
      ...(typeof a.toolCallId === 'string' ? { toolCallId: a.toolCallId } : {}),
      ...(typeof a.toolName === 'string' ? { toolName: a.toolName } : {}),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

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

// Error hints carry the real reason (the bare 'could not be persisted' hid
// the capability loss after tab switches/reloads).
{
  const { saveServerRunDraftBase } = await import('./serverRunDraftStore');
  const expectHint = async (runId: string, pattern: RegExp) => {
    await assert.rejects(
      saveServerRunDraftBase('project', runId, { text: 't', content: 'c', askOnly: false, references: [], baseDoc: {} as never }),
      (error: unknown) => error instanceof Error && pattern.test(error.message),
    );
  };
  await expectHint('draft-cap-403', /run capability was lost/);
  await expectHint('draft-gone-404', /no longer exists on the server/);
  await expectHint('draft-other-500', /HTTP 500/);
}

console.log('serverRunDraftStore.verify: recovery drafts redact credentials');
