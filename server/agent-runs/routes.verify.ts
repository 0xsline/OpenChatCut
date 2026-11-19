import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { agentRunsPlugin, MAX_DRAFT_BODY_BYTES } from './routes.ts';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore.ts';
import { MAX_ARTIFACT_BYTES } from '../../src/persist/agentRuntimeTypes.ts';
import {
  createRunWithCapability,
  digestToolArgs,
  getRun,
  flushServerRunPersistence,
  MAX_SERVER_RUN_EVENTS,
  pushRunEvent,
  recoverServerRun,
  resetServerRunStoreForTest,
  setRunStatus,
  waitForToolResult,
} from './store.ts';
import { MAX_SSE_SUBSCRIBERS_PER_RUN } from './sse.ts';
import {
  RUN_RECOVERY_DB_ENV,
  RunRecoveryStore,
  defaultRunRecoveryStorePath,
  resetRunRecoveryStoreForTest,
} from './run-recovery-store.ts';
import { beginRunRecoveryRuntime, resetRunRecoveryRuntimeForTest, stopRunRecoveryRuntime } from './run-recovery-runtime.ts';
import { denyRunRecoveryWrites } from './run-recovery-test-faults.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestValue } from './store-values.ts';

const executedRuns: Array<{ runId: string; resumed: boolean }> = [];

function applyPlugin(): ReturnType<typeof createMiniConnect> {
  const app = createMiniConnect((error) => { throw error; });
  const plugin = agentRunsPlugin({ activatePersistence: () => undefined, executeRun: async (run, _input, deps) => { executedRuns.push({ runId: run.id, resumed: Boolean(deps?.resume) }); } });
  const configure = plugin.configureServer;
  if (typeof configure !== 'function') throw new Error('agent run plugin has no configureServer hook');
  configure({ middlewares: { use: (route: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown) => app.use(route, handler) } } as never);
  return app;
}

const recoveryDirectory = mkdtempSync(join(tmpdir(), 'run-recovery-routes-'));
process.env[RUN_RECOVERY_DB_ENV] = join(recoveryDirectory, 'pi-run-recovery-v1.sqlite3');
assert.equal(defaultRunRecoveryStorePath(), process.env[RUN_RECOVERY_DB_ENV]);
const recoveryStore = new RunRecoveryStore(process.env[RUN_RECOVERY_DB_ENV]);
resetRunRecoveryStoreForTest(recoveryStore);

const server = createServer((req, res) => applyPlugin().handle(req, res));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const auth = { Host: `127.0.0.1:${address.port}`, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };


async function readSse(path: string, headers: Record<string, string> = {}): Promise<{ events: Array<{ id: number; type: string; data: unknown }>; text: string }> {
  const response = await fetch(`${origin}${path}`, { headers: { ...auth, Accept: 'text/event-stream', ...headers } });
  assert.equal(response.status, 200);
  const text = await response.text();
  const blocks = text.trim().split(/\n\n+/).filter(Boolean);
  const events = blocks.map((block) => {
    const fields: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      fields[line.slice(0, separator)] = line.slice(separator + 1).trimStart();
    }
    return { id: Number(fields.id), type: fields.event ?? '', data: JSON.parse(fields.data ?? 'null') };
  });
  return { events, text };
}

try {
  const invalidPolicy = await fetch(`${origin}/api/agent-runs/`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-invalid-policy',
      runId: '55555555-5555-4555-8555-555555555555',
      capability: 'b'.repeat(43),
      messages: [{ role: 'user', content: 'run' }],
      cacheMode: 'forever',
      maxOutputTokens: 64_000,
    }),
  });
  assert.equal(invalidPolicy.status, 400, 'invalid server-run model policy is rejected at admission');
  assert.match(
    String((await invalidPolicy.json() as { error?: unknown }).error),
    /cacheMode/,
  );
  const deferredRunId = '66666666-6666-4666-8666-666666666666';
  const deferredCapability = 'c'.repeat(43);
  const deferredPayload = {
    projectId: 'project-deferred-admission',
    runId: deferredRunId,
    capability: deferredCapability,
    messages: [{ role: 'user', content: 'run' }],
    cacheMode: 'short',
    maxOutputTokens: 4_096,
    askOnly: true,
  };
  const createDeferred = (payload: typeof deferredPayload) => fetch(`${origin}/api/agent-runs/`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const deferredCreate = await createDeferred(deferredPayload);
  assert.equal(deferredCreate.status, 201);
  const retriedCreate = await createDeferred(deferredPayload);
  assert.equal(retriedCreate.status, 200, 'identity-bound create retries are idempotent');
  const conflictingCreate = await createDeferred({
    ...deferredPayload,
    messages: [{ role: 'user', content: 'different run' }],
  });
  assert.equal(conflictingCreate.status, 409, 'a reused run identity cannot change its request');
  const deferredMetadata = await fetch(
    `${origin}/api/agent-runs/${deferredRunId}?projectId=project-deferred-admission`,
    { headers: { ...auth, 'X-OpenChatCut-Run-Capability': deferredCapability } },
  );
  assert.equal(
    (await deferredMetadata.json() as { status?: unknown }).status,
    'queued',
    'provider execution stays paused until the browser persists its recovery draft',
  );
  const deferredRun = getRun(deferredRunId);
  assert(deferredRun?.requestShapeHash);
  const deferredLedger = await loadAgentRuntimeSidecar('project-deferred-admission');
  const deferredRecord = deferredLedger.runs.find((record) => record.runId === deferredRunId);
  assert.equal(
    deferredRecord?.userInputDigest,
    digestValue([{ role: 'user', content: 'run' }]),
    'the durable input digest covers the validated model messages without storing them',
  );
  assert.notEqual(
    deferredRecord?.userInputDigest,
    deferredRun.requestShapeHash,
    'the complete request-shape digest is distinct from the input digest',
  );
  const deferredCancel = await fetch(`${origin}/api/agent-runs/${deferredRunId}/cancel`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': deferredCapability,
    },
    body: JSON.stringify({ projectId: 'project-deferred-admission' }),
  });
  assert.equal(deferredCancel.status, 200);
  resetServerRunStoreForTest();
  const { run, capability: runCapability } = createRunWithCapability({ id: '11111111-1111-4111-8111-111111111111', projectId: 'project-route', sessionGeneration: 'legacy', provider: 'deepseek', model: 'test', askOnly: true, references: [{ id: 'ref-1' }], externalSessionId: 'session-route', context: { requestShapeHash: 'shape-1' } });
  pushRunEvent(run, 'text-delta', { text: 'one' });
  pushRunEvent(run, 'text-delta', { text: 'two' });
  await setRunStatus(run, 'completed');
  await flushServerRunPersistence(run);
  resetServerRunStoreForTest();
  const unauthorizedRecovered = await fetch(
    `${origin}/api/agent-runs/${run.id}?projectId=${run.projectId}`,
    { headers: auth },
  );
  assert.equal(
    unauthorizedRecovered.status,
    403,
    'a recovered terminal run still requires its original capability',
  );
  const first = await readSse(
    `/api/agent-runs/${run.id}/events?projectId=${run.projectId}&after=0`,
    { 'X-OpenChatCut-Run-Capability': runCapability },
  );
  assert.deepEqual(first.events.map((event) => event.id), [1, 2, 3, 4]);
  const reconnect = await readSse(
    `/api/agent-runs/${run.id}/events?projectId=${run.projectId}&after=1`,
    {
      'Last-Event-ID': '1',
      'X-OpenChatCut-Run-Capability': runCapability,
    },
  );
  assert.deepEqual(reconnect.events.map((event) => event.id), [2, 3, 4], 'after and Last-Event-ID replay the later ordered suffix without duplicates');
  assert.equal(reconnect.events.at(-1)?.type, 'done');
  const recoveredMetadataResponse = await fetch(
    `${origin}/api/agent-runs/${run.id}?projectId=${run.projectId}`,
    { headers: { ...auth, 'X-OpenChatCut-Run-Capability': runCapability } },
  );
  assert.equal(recoveredMetadataResponse.status, 200, 'terminal replay recovers with stored verifier');
  const recoveredMetadata = await recoveredMetadataResponse.json() as Record<string, unknown>;
  assert(!Object.hasOwn(recoveredMetadata, 'capability'));
  assert(!Object.hasOwn(recoveredMetadata, 'capabilityVerifier'));
  const unauthorizedMetadata = await fetch(
    `${origin}/api/agent-runs/${run.id}?projectId=${run.projectId}`,
    { headers: auth },
  );
  assert.equal(unauthorizedMetadata.status, 403, 'run identifiers alone cannot read metadata');
  const forgedMetadata = await fetch(
    `${origin}/api/agent-runs/${run.id}?projectId=${run.projectId}`,
    {
      headers: {
        ...auth,
        'X-OpenChatCut-Run-Capability': 'A'.repeat(43),
      },
    },
  );
  assert.equal(forgedMetadata.status, 403, 'a forged run capability cannot read metadata');
  const unauthorizedEvents = await fetch(
    `${origin}/api/agent-runs/${run.id}/events?projectId=${run.projectId}&after=0`,
    { headers: { ...auth, Accept: 'text/event-stream' } },
  );
  assert.equal(unauthorizedEvents.status, 403, 'run identifiers alone cannot read events');
  const unauthorizedCancel = await fetch(
    `${origin}/api/agent-runs/${run.id}/cancel`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: run.projectId }),
    },
  );
  assert.equal(unauthorizedCancel.status, 403, 'run identifiers alone cannot cancel');
  const wrongProject = await fetch(
    `${origin}/api/agent-runs/${run.id}?projectId=other-project`,
    { headers: { ...auth, 'X-OpenChatCut-Run-Capability': runCapability } },
  );
  assert.equal(wrongProject.status, 409, 'metadata is project-bound');
  const malformedCursor = await fetch(
    `${origin}/api/agent-runs/${run.id}/events?projectId=${run.projectId}&after=abc`,
    {
      headers: {
        ...auth,
        Accept: 'text/event-stream',
        'X-OpenChatCut-Run-Capability': runCapability,
      },
    },
  );
  assert.equal(malformedCursor.status, 400, 'cursor syntax is strict');
  const { run: toolRun, capability: toolCapability } = createRunWithCapability({
    id: '33333333-3333-4333-8333-333333333333',
    projectId: 'project-large-tool-result',
    sessionGeneration: 'legacy',
    provider: 'deepseek',
    model: 'test',
  });
  await setRunStatus(toolRun, 'running');
  const largeArgsDigest = digestToolArgs({ frames: [10, 20] });
  const delivered = waitForToolResult(
    toolRun,
    'call-large-result',
    'view_timeline_frames',
    largeArgsDigest,
  );
  const toolBinding = {
    projectId: toolRun.projectId,
    toolCallId: 'call-large-result',
    argsDigest: largeArgsDigest,
    claimId: 'browser-large-result',
  };
  const unauthorizedClaim = await fetch(
    `${origin}/api/agent-runs/${toolRun.id}/tool-claim`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(toolBinding),
    },
  );
  assert.equal(unauthorizedClaim.status, 403, 'a sibling tab cannot claim with identifiers alone');
  const prematureResult = await fetch(
    `${origin}/api/agent-runs/${toolRun.id}/tool-result`,
    {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'X-OpenChatCut-Run-Capability': toolCapability,
      },
      body: JSON.stringify({ ...toolBinding, result: { image: 'premature' } }),
    },
  );
  assert.equal(prematureResult.status, 409, 'tool settlement requires a prior claim');
  assert.equal(
    (await prematureResult.json() as { outcome?: unknown }).outcome,
    'unclaimed',
  );
  const authorizedClaim = await fetch(
    `${origin}/api/agent-runs/${toolRun.id}/tool-claim`,
    {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'X-OpenChatCut-Run-Capability': toolCapability,
      },
      body: JSON.stringify(toolBinding),
    },
  );
  assert.equal(authorizedClaim.status, 200);
  const unauthorizedResult = await fetch(
    `${origin}/api/agent-runs/${toolRun.id}/tool-result`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...toolBinding, result: { image: 'forged' } }),
    },
  );
  assert.equal(unauthorizedResult.status, 403, 'a sibling tab cannot settle a claimed tool');
  const oversizedPayload = 'x'.repeat(1_100_000);
  const oversizedResult = await fetch(
    `${origin}/api/agent-runs/${toolRun.id}/tool-result`,
    {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'X-OpenChatCut-Run-Capability': toolCapability,
      },
      body: JSON.stringify({ ...toolBinding, result: { image: oversizedPayload } }),
    },
  );
  assert.equal(oversizedResult.status, 413, 'tool results are bounded to the standard 1 MiB envelope');
  const acceptedPayload = 'x'.repeat(800_000);
  const acceptedResult = await fetch(
    `${origin}/api/agent-runs/${toolRun.id}/tool-result`,
    {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'X-OpenChatCut-Run-Capability': toolCapability,
      },
      body: JSON.stringify({ ...toolBinding, result: { image: acceptedPayload } }),
    },
  );
  assert.equal(acceptedResult.status, 200);
  const deliveredResult = await delivered;
  assert(
    deliveredResult !== null
      && typeof deliveredResult === 'object'
      && 'image' in deliveredResult
      && typeof deliveredResult.image === 'string',
  );
  assert.equal(deliveredResult.image.length, acceptedPayload.length);

  const { run: capRun, capability: capCapability } = createRunWithCapability({ id: '22222222-2222-4222-8222-222222222222', projectId: 'project-cap', sessionGeneration: 'legacy', provider: 'deepseek', model: 'test' });
  for (let index = 0; index < MAX_SERVER_RUN_EVENTS * 4 + 2; index += 1) {
    pushRunEvent(capRun, 'tool-request', {
      toolCallId: `cap-${index}`,
      name: 'read_timeline',
      args: {},
      argsDigest: `cap-${index}`,
    });
  }
  await flushServerRunPersistence(capRun);
  resetServerRunStoreForTest();
  const capRecovered = await recoverServerRun(capRun.projectId, capRun.id);
  assert.equal(capRecovered?.status, 'failed', 'a run the restart cut off recovers as failed');
  const cappedResponse = await fetch(
    `${origin}/api/agent-runs/${capRun.id}/events?projectId=${capRun.projectId}&after=0`,
    {
      headers: {
        ...auth,
        Accept: 'text/event-stream',
        'X-OpenChatCut-Run-Capability': capCapability,
      },
    },
  );
  assert.equal(cappedResponse.status, 410, 'a cursor before the bounded replay window is explicit');
  const capped = await readSse(
    `/api/agent-runs/${capRun.id}/events?projectId=${capRun.projectId}&after=${capRecovered?.replayStart ? capRecovered.replayStart - 1 : 0}`,
    { 'X-OpenChatCut-Run-Capability': capCapability },
  );
  assert.deepEqual(capped.events.map((event) => event.id), [...new Set(capped.events.map((event) => event.id))]);
  const { run: subscriberRun, capability: subscriberCapability } = createRunWithCapability({
    id: '77777777-7777-4777-8777-777777777777',
    projectId: 'project-subscriber-cap',
    sessionGeneration: 'legacy',
    provider: 'deepseek',
    model: 'test',
  });
  pushRunEvent(subscriberRun, 'status', { status: 'queued' });
  const subscriberUrl = `${origin}/api/agent-runs/${subscriberRun.id}/events`
    + `?projectId=${subscriberRun.projectId}&after=0`;
  const subscriberHeaders = {
    ...auth,
    Accept: 'text/event-stream',
    'X-OpenChatCut-Run-Capability': subscriberCapability,
  };
  const subscriptions = await Promise.all(Array.from(
    { length: MAX_SSE_SUBSCRIBERS_PER_RUN },
    () => fetch(subscriberUrl, { headers: subscriberHeaders }),
  ));
  assert(subscriptions.every((response) => response.status === 200));
  const rejectedSubscription = await fetch(subscriberUrl, { headers: subscriberHeaders });
  assert.equal(rejectedSubscription.status, 429, 'SSE subscribers are bounded per run');
  assert.equal(rejectedSubscription.headers.get('retry-after'), '1');
  await Promise.all(subscriptions.map((response) => response.body?.cancel()));
  await flushServerRunPersistence();

  // Codex backend admission: no LLM key is required (Codex uses the local CLI
  // login), the run is created with backend 'codex', and provider defaults to
  // openai.
  const codexRunId = crypto.randomUUID();
  const codexCapability = 'd'.repeat(43);
  const codexCreate = await fetch(`${origin}/api/agent-runs/`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-codex-admission',
      runId: codexRunId,
      capability: codexCapability,
      backend: 'codex',
      provider: 'openai',
      model: 'codex-mini-latest',
      messages: [{ role: 'user', content: 'run' }],
      cacheMode: 'short',
      maxOutputTokens: 4_096,
      askOnly: true,
    }),
  });
  assert.equal(codexCreate.status, 201, 'codex backend is admitted without an LLM API key');
  const codexRun = getRun(codexRunId);
  assert.equal(codexRun?.backend, 'codex', 'run records the codex backend');
  assert.equal(codexRun?.provider, 'openai', 'codex runs are normalized to the openai provider');
  // Codex admission: the recovery row is written before the create response, so a
  // crash between the sidecar write and the admission can be repaired by the
  // identical create retry instead of starting a second executor.
  const recoveryRunId = crypto.randomUUID();
  const recoveryCapability = 'e'.repeat(43);
  const recoveryPayload = {
    projectId: 'project-recovery-admission',
    runId: recoveryRunId,
    capability: recoveryCapability,
    backend: 'codex',
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'run' }],
    cacheMode: 'short',
    maxOutputTokens: 4_096,
    askOnly: true,
  };
  const recoveryCreate = await fetch(`${origin}/api/agent-runs/`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(recoveryPayload),
  });
  assert.equal(recoveryCreate.status, 201, 'pi backend is admitted without an LLM API key');
  const recoveryRun = getRun(recoveryRunId);
  assert.ok(recoveryRun);
  const recovery = recoveryStore.load({
    projectId: recoveryRun.projectId,
    sessionGeneration: recoveryRun.sessionGeneration,
    runId: recoveryRun.id,
  });
  assert.ok(recovery, 'a Codex run has a durable recovery admission before the response');
  assert.equal(recovery.phase, 'admitted');
  assert.equal(recovery.ownerInstance, null, 'admission alone grants no execution authority');
  assert.ok(
    recovery.admissionExpiresAt > Date.now(),
    'the admission deadline is persisted, not just held in memory',
  );
  const recoveryRetry = await fetch(`${origin}/api/agent-runs/`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(recoveryPayload),
  });
  assert.equal(recoveryRetry.status, 200, 'the identical create retry is idempotent');
  const afterRetry = recoveryStore.load({
    projectId: recoveryRun.projectId,
    sessionGeneration: recoveryRun.sessionGeneration,
    runId: recoveryRun.id,
  });
  assert.equal(
    afterRetry?.admissionExpiresAt,
    recovery.admissionExpiresAt,
    'a retry never extends the persisted admission deadline',
  );

  // Claim ordering, asserted at the HTTP boundary the browser uses: the durable
  // claim is committed before the response, so "no claim record" is genuine
  // evidence that execution authority was never granted.
  const claimDigest1 = digestToolArgs({ probe: 1 });
  const claimDigest2 = digestToolArgs({ probe: 2 });
  const recoveryRuntime = beginRunRecoveryRuntime(recoveryRun, { instanceId: 'routes-verify' });
  assert.ok(recoveryRuntime, 'the route-level fixture owns the run');
  const firstIntent = await recoveryRuntime.sink.beginTool({
    toolCallId: 'call-claim-1',
    name: 'read_timeline',
    argsDigest: claimDigest1,
  });
  pushRunEvent(recoveryRun, 'tool-request', {
    toolCallId: 'call-claim-1',
    name: 'read_timeline',
    args: {},
    argsDigest: claimDigest1,
  });
  const pendingClaim = waitForToolResult(recoveryRun, 'call-claim-1', 'read_timeline', claimDigest1);
  void pendingClaim.catch(() => undefined);
  const claimResponse = await fetch(`${origin}/api/agent-runs/${recoveryRunId}/tool-claim`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': recoveryCapability,
    },
    body: JSON.stringify({
      projectId: recoveryRun.projectId,
      toolCallId: 'call-claim-1',
      argsDigest: claimDigest1,
      claimId: 'browser-claim-1',
    }),
  });
  assert.equal(claimResponse.status, 200);
  assert.equal((await claimResponse.json() as { claimed?: unknown }).claimed, true);
  const claimedRow = recoveryStore.load({
    projectId: recoveryRun.projectId,
    sessionGeneration: recoveryRun.sessionGeneration,
    runId: recoveryRun.id,
  })!.tools.find((tool) => tool.toolCallId === 'call-claim-1');
  assert.ok(claimedRow, 'the intent was recorded before the request became visible');
  assert.equal(claimedRow.opSeq, firstIntent.opSeq);
  assert.equal(
    claimedRow.state,
    'claimed',
    'the claim is durable by the time the browser is told it may execute',
  );
  assert.equal(claimedRow.claimId, 'browser-claim-1');

  // A second claimant cannot win authority for the same operation.
  const secondClaim = await fetch(`${origin}/api/agent-runs/${recoveryRunId}/tool-claim`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': recoveryCapability,
    },
    body: JSON.stringify({
      projectId: recoveryRun.projectId,
      toolCallId: 'call-claim-1',
      argsDigest: claimDigest1,
      claimId: 'browser-claim-2',
    }),
  });
  assert.equal(secondClaim.status, 409, 'a granted claim is not handed to a second claimant');

  // When the durable claim cannot be written, the route must not answer
  // `claimed`: the browser would then execute work the server cannot account for.
  await recoveryRuntime.sink.beginTool({
    toolCallId: 'call-claim-2',
    name: 'read_timeline',
    argsDigest: claimDigest2,
  });
  pushRunEvent(recoveryRun, 'tool-request', {
    toolCallId: 'call-claim-2',
    name: 'read_timeline',
    args: {},
    argsDigest: claimDigest2,
  });
  const refusedPending = waitForToolResult(recoveryRun, 'call-claim-2', 'read_timeline', claimDigest2);
  void refusedPending.catch(() => undefined);
  const restoreWrites = denyRunRecoveryWrites(recoveryStore);
  const refusedClaim = await fetch(`${origin}/api/agent-runs/${recoveryRunId}/tool-claim`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': recoveryCapability,
    },
    body: JSON.stringify({
      projectId: recoveryRun.projectId,
      toolCallId: 'call-claim-2',
      argsDigest: claimDigest2,
      claimId: 'browser-claim-3',
    }),
  });
  restoreWrites();
  assert.equal(refusedClaim.status, 409, 'an unrecordable claim is refused, not granted');
  const refusedBody = await refusedClaim.json() as { claimed?: unknown; outcome?: unknown };
  assert.equal(refusedBody.claimed, false, 'the refused claim never tells the browser it may execute');
  assert.equal(refusedBody.outcome, 'claim-write-failed');
  // The in-memory request stays pending: no execution authority was handed out.
  assert.equal(recoveryRun.toolRequests.get('call-claim-2')?.claimId, undefined);
  void pendingClaim;
  void refusedPending;

  // GET metadata exposes the recovery view for a Codex run, and reading it must not
  // grant execution authority or start a model.
  const recoveryMetadata = await fetch(
    `${origin}/api/agent-runs/${recoveryRunId}?projectId=${recoveryRun.projectId}`,
    { headers: { ...auth, 'X-OpenChatCut-Run-Capability': recoveryCapability } },
  );
  assert.equal(recoveryMetadata.status, 200);
  const recoveryMetadataBody = await recoveryMetadata.json() as {
    recovery?: { state?: unknown; revision?: unknown; replayBase?: { resetsCursor?: unknown } };
    status?: unknown;
  };
  assert.ok(recoveryMetadataBody.recovery, 'the metadata carries the recovery projection');
  assert.equal(
    recoveryMetadataBody.recovery!.state,
    'admitted',
    'the run has an admission but has not been started, so it stays on the admission path',
  );
  assert.equal(typeof recoveryMetadataBody.recovery!.revision, 'number');
  assert.equal(
    recoveryStore.load({
      projectId: recoveryRun.projectId,
      sessionGeneration: recoveryRun.sessionGeneration,
      runId: recoveryRun.id,
    })?.ownerInstance,
    'routes-verify',
    'reading metadata did not take ownership away from the live executor',
  );

  // Resume is refused while a tool has no durable outcome: starting would
  // re-dispatch the very operation whose effect is unknown.
  const resumeTooEarly = await fetch(`${origin}/api/agent-runs/${recoveryRunId}/start`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': recoveryCapability,
    },
    body: JSON.stringify({
      projectId: recoveryRun.projectId,
      mode: 'resume',
      expectedRevision: recoveryMetadataBody.recovery!.revision,
      recorderId: 'routes-recorder',
      cursor: 0,
    }),
  });
  assert.equal(resumeTooEarly.status, 200);
  assert.equal((await resumeTooEarly.json() as { outcome?: string }).outcome, 'already_started',
    'a live owner continues serving its original request without another executor');

  // The happy path, on its own run: admission, a persisted request and no
  // outstanding tool leaves the handshake free to grant authority.
  const recoveryResumeRunId = crypto.randomUUID();
  const recoveryResumeCapability = 'f'.repeat(43);
  const recoveryResumeCreate = await fetch(`${origin}/api/agent-runs/`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-recovery-resume',
      runId: recoveryResumeRunId,
      capability: recoveryResumeCapability,
      backend: 'codex',
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'continue the run' }],
      cacheMode: 'short',
      maxOutputTokens: 4_096,
      askOnly: true,
    }),
  });
  assert.equal(recoveryResumeCreate.status, 201);
  const recoveryResumeRun = getRun(recoveryResumeRunId)!;
  const recoveryResumeKey = {
    projectId: recoveryResumeRun.projectId,
    sessionGeneration: recoveryResumeRun.sessionGeneration,
    runId: recoveryResumeRun.id,
  };
  const resumeRuntime = beginRunRecoveryRuntime(recoveryResumeRun, { instanceId: 'routes-resume' });
  assert.ok(resumeRuntime);
  await resumeRuntime.sink.beginRequest({
    requestIndex: 1,
    prompt: 'USER:\ncontinue the run',
    messages: [{ role: 'user', content: 'continue the run' }],
    toolNames: ['read_timeline'],
  });
  stopRunRecoveryRuntime(recoveryResumeRun);
  const readyMetadata = await (await fetch(
    `${origin}/api/agent-runs/${recoveryResumeRunId}?projectId=${recoveryResumeRun.projectId}`,
    { headers: { ...auth, 'X-OpenChatCut-Run-Capability': recoveryResumeCapability } },
  )).json() as {
    recovery: { state?: unknown; revision: number; replayBase?: { resetsCursor?: unknown } };
  };
  assert.equal(readyMetadata.recovery.state, 'ready');
  assert.equal(
    readyMetadata.recovery.replayBase?.resetsCursor,
    true,
    'a resumable run publishes the baseline the browser must adopt instead of a stale cursor',
  );
  const acceptedResume = await fetch(`${origin}/api/agent-runs/${recoveryResumeRunId}/start`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': recoveryResumeCapability,
    },
    body: JSON.stringify({
      projectId: recoveryResumeRun.projectId,
      mode: 'resume',
      expectedRevision: readyMetadata.recovery.revision,
      recorderId: 'routes-recorder',
      cursor: 0,
    }),
  });
  assert.equal(acceptedResume.status, 202, 'a reconciled run is granted execution authority');
  assert.deepEqual(executedRuns, [{ runId: recoveryResumeRun.id, resumed: true }],
    'the HTTP handshake dispatches the persisted recovery input exactly once');
  assert.equal(
    recoveryStore.load(recoveryResumeKey)?.tools.length,
    0,
    'starting the resume dispatch nothing by itself',
  );

  // A stale expectedRevision is refused on its own terms.
  const staleResume = await fetch(`${origin}/api/agent-runs/${recoveryRunId}/start`, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'X-OpenChatCut-Run-Capability': recoveryCapability,
    },
    body: JSON.stringify({
      projectId: recoveryRun.projectId,
      mode: 'resume',
      expectedRevision: -1,
      recorderId: 'routes-recorder',
      cursor: 0,
    }),
  });
  assert.equal(staleResume.status, 409);
  assert.match(
    String((await staleResume.json() as { error?: unknown }).error),
    /revision/,
  );

  // A browser can post its original result after the owner froze and the
  // in-memory request disappeared. The durable claim remains its authority.
  stopRunRecoveryRuntime(recoveryRun);
  clearTimeout(recoveryRun.toolRequests.get('call-claim-1')?.timeout);
  recoveryRun.toolRequests.delete('call-claim-1');
  const submitLate = () => fetch(`${origin}/api/agent-runs/${recoveryRunId}/tool-result`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': recoveryCapability },
    body: JSON.stringify({ projectId: recoveryRun.projectId, toolCallId: 'call-claim-1',
      argsDigest: claimDigest1, claimId: 'browser-claim-1', result: { timeline: [] } }),
  });
  const recordOutcome = recoveryStore.recordBrowserOutcome;
  recoveryStore.recordBrowserOutcome = () => { throw new Error('injected outcome write failure'); };
  assert.equal((await submitLate()).status, 409, 'a failed durable write is never acknowledged');
  recoveryStore.recordBrowserOutcome = recordOutcome;
  const late = await submitLate();
  assert.equal(late.status, 200, 'a durable late result succeeds even without an in-memory request');
  assert.equal((await late.json() as { ok: boolean }).ok, true);
  assert.equal((await submitLate()).status, 200, 'a lost HTTP acknowledgement can be retried');
  clearTimeout(recoveryRun.toolRequests.get('call-claim-2')?.timeout);

  const cancelRecovery = await fetch(`${origin}/api/agent-runs/${recoveryRunId}/cancel`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': recoveryCapability },
    body: JSON.stringify({ projectId: recoveryRun.projectId }),
  });
  assert.equal(cancelRecovery.status, 200);
  assert.equal(recoveryStore.load({ projectId: recoveryRun.projectId,
    sessionGeneration: recoveryRun.sessionGeneration, runId: recoveryRun.id })?.phase, 'finalized',
  'explicit cancellation releases admission capacity even when no executor was running');

  // Codex uses the same admission, metadata, claim and outcome boundary.
  assert.ok(codexRun);
  const codexKey = { projectId: codexRun.projectId, sessionGeneration: codexRun.sessionGeneration, runId: codexRun.id };
  assert.equal(recoveryStore.load(codexKey)?.backend, 'codex');
  const codexRuntime = beginRunRecoveryRuntime(codexRun, { instanceId: 'codex-routes' });
  assert.ok(codexRuntime);
  await codexRuntime.sink.beginRequest({ requestIndex: 1, prompt: 'codex request',
    messages: [{ role: 'user', content: 'codex request' }], toolNames: ['read_timeline'], instructions: 'codex instructions' });
  const codexDigest = digestToolArgs({});
  await codexRuntime.sink.beginTool({ toolCallId: 'codex-read', name: 'read_timeline', argsDigest: codexDigest });
  const codexPending = waitForToolResult(codexRun, 'codex-read', 'read_timeline', codexDigest);
  const codexHeaders = { ...auth, 'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': codexCapability };
  const codexBinding = { projectId: codexRun.projectId, toolCallId: 'codex-read', argsDigest: codexDigest, claimId: 'codex-claim' };
  const codexClaim = await fetch(`${origin}/api/agent-runs/${codexRunId}/tool-claim`, {
    method: 'POST', headers: codexHeaders, body: JSON.stringify(codexBinding),
  });
  assert.equal(codexClaim.status, 200);
  assert.equal(recoveryStore.load(codexKey)?.tools[0].state, 'claimed');
  const codexResult = await fetch(`${origin}/api/agent-runs/${codexRunId}/tool-result`, {
    method: 'POST', headers: codexHeaders, body: JSON.stringify({ ...codexBinding, result: { timeline: [] } }),
  });
  assert.equal(codexResult.status, 200);
  assert.equal(recoveryStore.load(codexKey)?.tools[0].state, 'outcome', 'Codex results are durable before HTTP acknowledgement');
  assert.deepEqual(await codexPending, { timeline: [] });
  const codexMetadata = await (await fetch(`${origin}/api/agent-runs/${codexRunId}?projectId=${codexRun.projectId}`, {
    headers: codexHeaders,
  })).json() as { recovery?: { state: string } };
  assert.equal(codexMetadata.recovery?.state, 'active');
  await fetch(`${origin}/api/agent-runs/${codexRunId}/cancel`, {
    method: 'POST', headers: codexHeaders, body: JSON.stringify({ projectId: codexRun.projectId }),
  });
  assert.equal(recoveryStore.load(codexKey)?.phase, 'finalized');

  // API joins shared recovery; Copilot keeps its existing metadata contract.
  for (const backend of ['api', 'copilot']) {
    const runId = crypto.randomUUID();
    const projectId = `project-${backend}-no-recovery`;
    const capability = 'g'.repeat(43);
    const headers = { ...auth, 'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': capability };
    const created = await fetch(`${origin}/api/agent-runs/`, {
      method: 'POST', headers, body: JSON.stringify({ projectId, runId, capability, backend,
        provider: 'openai', model: 'test-model', messages: [{ role: 'user', content: 'run' }], cacheMode: 'short', maxOutputTokens: 4096 }),
    });
    assert.equal(created.status, 201);
    const metadata = await (await fetch(`${origin}/api/agent-runs/${runId}?projectId=${projectId}`, { headers })).json() as { recovery?: unknown };
    const durable = recoveryStore.load({ projectId, sessionGeneration: getRun(runId)!.sessionGeneration, runId });
    if (backend === 'api') {
      assert.equal((metadata.recovery as { state?: string })?.state, 'admitted');
      assert.equal(durable?.backend, 'api');
      assert.equal(durable?.executionInput?.provider, 'openai');
    } else {
      assert.equal(metadata.recovery, undefined, 'Copilot publishes no shared recovery metadata');
      assert.equal(durable, null);
    }
    await fetch(`${origin}/api/agent-runs/${runId}/cancel`, { method: 'POST', headers, body: JSON.stringify({ projectId }) });
    if (backend === 'api') {
      assert.equal(recoveryStore.load({ projectId, sessionGeneration: getRun(runId)!.sessionGeneration, runId })?.phase, 'finalized');
    }
  }
} finally {
  resetRunRecoveryRuntimeForTest();
  resetRunRecoveryStoreForTest(null);
  rmSync(recoveryDirectory, { recursive: true, force: true });
  delete process.env[RUN_RECOVERY_DB_ENV];
  resetServerRunStoreForTest();
  server.close();
}

// Draft persistence guard rails (issue: 'Server run draft could not be
// persisted' after tab switches). HTTP-level probing of these routes is
// platform-fragile (undici setTypeOfService EINVAL on macOS loopback), so
// assert the exact status/error contract the client hint logic depends on.
{
  const source = await readFile(new URL('./routes.ts', import.meta.url), 'utf8');
  assert.match(source, /error: 'invalid run capability'/, 'draft without a valid capability is rejected 403');
  assert.match(source, /sendJson\(res, 404, \{ error: 'run not found' \}\)/, 'draft for an unknown run is rejected 404');
  assert.match(source, /sendJson\(res, 409, \{ error: 'draft artifact was rejected \(invalid, duplicate, or over the limit\)' \}\)/, 'malformed draft artifacts are rejected 409');

  // The draft route must not inherit readJson's 1 MiB default: the producer,
  // the snapshot validation and the durable store all contract at 8 MiB, so a
  // smaller transport cap rejects drafts the client was told to send (413)
  // while its own guard reported them as within the limit.
  assert.match(
    source,
    /handleDraftStore[\s\S]{0,200}?readJson\(req,\s*MAX_DRAFT_BODY_BYTES\)/,
    'the draft route must pass an explicit body limit sized for the artifact cap',
  );
  assert.ok(
    MAX_DRAFT_BODY_BYTES > MAX_ARTIFACT_BYTES,
    'the draft transport limit must exceed the artifact cap to leave room for JSON re-escaping',
  );

  // A maximum-size artifact must fit the transport limit once it is embedded in
  // the request envelope, including worst-case re-escaping of a JSON body.
  const worstCaseEnvelope = MAX_ARTIFACT_BYTES * 2;
  assert.ok(
    MAX_DRAFT_BODY_BYTES >= worstCaseEnvelope,
    `an ${MAX_ARTIFACT_BYTES}-byte artifact must fit the ${MAX_DRAFT_BODY_BYTES}-byte transport limit after escaping`,
  );
}

console.log('agent-runs/routes.verify: ordered SSE replay, reconnect, terminal closure, metadata and cap failure OK');
