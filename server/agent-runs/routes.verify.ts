import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { agentRunsPlugin } from './routes.ts';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore.ts';
import {
  createRunWithCapability,
  digestToolArgs,
  getRun,
  flushServerRunPersistence,
  MAX_SERVER_RUN_EVENTS,
  pushRunEvent,
  resetServerRunStoreForTest,
  setRunStatus,
  waitForToolResult,
} from './store.ts';
import { MAX_SSE_SUBSCRIBERS_PER_RUN } from './sse.ts';
import { digestValue } from './store-values.ts';

function applyPlugin(): ReturnType<typeof createMiniConnect> {
  const app = createMiniConnect((error) => { throw error; });
  const plugin = agentRunsPlugin({ activatePersistence: () => undefined });
  const configure = plugin.configureServer;
  if (typeof configure !== 'function') throw new Error('agent run plugin has no configureServer hook');
  configure({ middlewares: { use: (route: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown) => app.use(route, handler) } } as never);
  return app;
}

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
  for (let index = 0; index < MAX_SERVER_RUN_EVENTS; index += 1) pushRunEvent(capRun, 'text-delta', { index });
  assert.throws(() => pushRunEvent(capRun, 'text-delta', { index: MAX_SERVER_RUN_EVENTS }), /event limit/);
  await capRun.terminalPromise;
  assert.equal(capRun.status, 'failed');
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
    `/api/agent-runs/${capRun.id}/events?projectId=${capRun.projectId}&after=${capRun.replayStart - 1}`,
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
} finally {
  resetServerRunStoreForTest();
  server.close();
}

console.log('agent-runs/routes.verify: ordered SSE replay, reconnect, terminal closure, metadata and cap failure OK');
