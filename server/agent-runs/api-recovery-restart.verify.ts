import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { openServerRunEventStream } from '../../src/agent/serverRunFetchEventStream.ts';
import catalog from '../../assets/agent/openchatcut-tool-schemas.json';

const FAKE_KEY = 'api-recovery-fixture-only';
const B_RESULT = { receipt: 'review-edit-receipt', applied: true, revision: 7 };
const B_MODEL_RESULT = { ...B_RESULT, activatedTools: [] };
const C_RESULT = [{ itemId: 'clip-7', durationInFrames: 120 }, { checked: true }];
const EDIT = { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 120 }] };
type Scenario = 'partial-response' | 'unknown-write' | 'completed-round';
type ChatMessage = { role: string; content?: unknown; tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type ProviderRequest = { model: string; stream: boolean; messages: ChatMessage[]; tools: unknown[] };

async function serve(): Promise<void> {
  // The child receives a minimal environment and an isolated data directory.
  // Seed only explicit fixture credentials; no dotenv or user keystore is read.
  const { KEY_NAMES, seedKeystore } = await import('../keystore.ts');
  seedKeystore({ ...Object.fromEntries(KEY_NAMES.map((name) => [name, ''])),
    LLM_PROVIDER: 'openai', LLM_OPENAI_API_KEY: FAKE_KEY,
    LLM_OPENAI_BASE_URL: process.env.TEST_PROVIDER_ORIGIN + '/v1',
    LLM_OPENAI_API_MODE: 'chat', LLM_OPENAI_MODEL: 'gpt-4.1',
  });
  const { agentRunsPlugin } = await import('./routes.ts');
  const { llmProxyPlugin } = await import('../plugins/llm-proxy.ts');
  const app = createMiniConnect((error) => { throw error; });
  for (const plugin of [llmProxyPlugin(), agentRunsPlugin()]) {
    const configure = plugin.configureServer;
    assert.equal(typeof configure, 'function');
    if (typeof configure === 'function') configure({ middlewares: app } as never);
  }
  const server = createServer((req, res) => app.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  process.send!(address.port);
}

function complete(res: ServerResponse, calls: Array<{ id: string; name: string; args: object }>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const chunk = { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1',
    choices: [{ index: 0, delta: calls.length ? { role: 'assistant', tool_calls: calls.map((call, index) => ({
      index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } : { role: 'assistant', content: 'Recovered edit and timeline confirmed.' }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {},
    finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function assertToolOutput(messages: ChatMessage[], id: string, expected: unknown): void {
  const tool = messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert(tool, `tool output ${id} is preserved`);
  assert.equal(typeof tool.content, 'string');
  assert.deepEqual(JSON.parse(tool.content as string), expected, `${id}: result keeps its original JSON type`);
  assert(messages.some((message) => message.role === 'assistant' && message.tool_calls?.some((call) => call.id === id)),
    `${id}: replay retains the matching assistant tool call`);
}

export async function exerciseApiRecoveryRestart(scenario: Scenario): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), `openchatcut-api-${scenario}-`));
  const databasePath = join(profile, 'recovery.sqlite');
  const runId = crypto.randomUUID();
  const projectId = 'api-recovery-test';
  const capability = 'a'.repeat(43);
  const base = '/api/agent-runs/' + runId;
  const counts = { edit_item: 0, read_timeline: 0 };
  const requests: Array<{ phase: string; body: ProviderRequest }> = [];
  const providerFailure = Promise.withResolvers<never>();
  void providerFailure.promise.catch(() => undefined);
  const nextRound = Promise.withResolvers<void>();
  let child: ChildProcess | undefined;
  let origin = '';
  let phase = 'first';
  let heldResponse: ServerResponse | undefined;
  const provider = createServer((req, res) => {
    void (async () => {
      assert.equal(req.url, '/v1/chat/completions', 'the real chat adapter uses the configured local provider');
      assert.equal(req.headers.authorization, 'Bearer ' + FAKE_KEY, 'the real proxy injects only the fixture key');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest;
      assert.equal(body.model, 'gpt-4.1');
      assert.equal(body.stream, true);
      const names = body.tools.map((tool) => (tool as { function: { name: string } }).function.name);
      assert(names.includes('edit_item') && names.includes('read_timeline'));
      const previous = requests.filter((request) => request.phase === phase);
      requests.push({ phase, body });
      if (phase === 'first') {
        if (!previous.length) {
          complete(res, [{ id: 'B', name: 'edit_item', args: EDIT },
            ...(scenario === 'completed-round' ? [] : [{ id: 'C', name: 'read_timeline', args: {} }])]);
          return;
        }
        assert.equal(scenario, 'completed-round', 'partial response must not advance to another provider round');
        assertToolOutput(body.messages, 'B', B_MODEL_RESULT);
        heldResponse = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        nextRound.resolve();
        return;
      }
      assert.notEqual(scenario, 'unknown-write', 'an unknown write must never reach the provider again');
      if (!previous.length) {
        const interrupted = scenario === 'completed-round'
          ? requests.find((request) => request.phase === 'first' && request.body.messages.some((message) => message.role === 'tool'))!
          : requests.find((request) => request.phase === 'first')!;
        assert.deepEqual(body.messages, interrupted.body.messages, 'restart sends the exact persisted prepared request');
        assert.deepEqual(body.tools, interrupted.body.tools, 'restart preserves the active tool schemas');
        if (scenario === 'completed-round') {
          assertToolOutput(body.messages, 'B', B_MODEL_RESULT);
          complete(res, [{ id: 'C-new', name: 'read_timeline', args: {} }]);
        } else {
          assert(!body.messages.some((message) => message.role === 'tool'), 'partial recovery must not synthesize a tool transcript');
          complete(res, [{ id: 'B-new', name: 'edit_item', args: EDIT }, { id: 'C-new', name: 'read_timeline', args: {} }]);
        }
      } else {
        assertToolOutput(body.messages, scenario === 'completed-round' ? 'B' : 'B-new', B_MODEL_RESULT);
        assertToolOutput(body.messages, 'C-new', C_RESULT);
        complete(res, []);
      }
    })().catch((error) => {
      providerFailure.reject(error);
      if (!res.writableEnded) { res.writeHead(500); res.end('fixture assertion failed'); }
    });
  });
  const race = <T>(promise: Promise<T>) => Promise.race([promise, providerFailure.promise]);
  const headers = () => ({ Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
    'X-OpenChatCut-Run-Capability': capability });
  async function start(nextPhase: string): Promise<void> {
    phase = nextPhase;
    const providerAddress = provider.address();
    assert(providerAddress && typeof providerAddress === 'object');
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test',
      OPENCHATCUT_DATA_DIR: profile, OPENCHATCUT_RUN_RECOVERY_DB: databasePath,
      TEST_PROVIDER_ORIGIN: `http://127.0.0.1:${providerAddress.port}`,
    };
    child = fork(fileURLToPath(import.meta.url), ['serve'], { execArgv: ['--import', 'tsx'], env: environment });
    const [port] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      once(child, 'exit').then(([code, signal]) => { throw Error(`Fixture editor exited before listening: ${code ?? signal}`); }),
    ]);
    origin = 'http://127.0.0.1:' + port;
  }
  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    heldResponse?.destroy();
  }
  async function post(path: string, body: object) {
    const response = await fetch(origin + path, { method: 'POST', headers: headers(),
      body: JSON.stringify({ projectId, ...body }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  async function metadata() {
    const response = await fetch(origin + base + '?projectId=' + projectId,
      { headers: headers(), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  function checkpoint() {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare('SELECT request_state, request_index, messages FROM run_recovery_runs WHERE run_id = ?').get(runId) as
        { request_state: string; request_index: number; messages: string };
      assert(row);
      return { state: row.request_state, index: row.request_index, messages: JSON.parse(row.messages) };
    } finally { database.close(); }
  }
  async function consume(after: number, until: 'B' | 'done'): Promise<void> {
    const done = Promise.withResolvers<void>();
    const timer = setTimeout(() => done.reject(Error(`${scenario}: SSE timeout before ${until}`)), 15_000);
    const operations = new Set<Promise<void>>();
    const stream = openServerRunEventStream({ projectId, runId, capability, after,
      fetch: async (url, init) => {
        const response = await fetch(new URL(String(url), origin), { ...init, headers: { ...init?.headers, ...headers() } });
        if (!response.ok) providerFailure.reject(Error(`SSE HTTP ${response.status}: ${await response.text()}`));
        return response;
      } });
    async function execute(event: Event): Promise<void> {
      const { toolCallId, argsDigest, name } = JSON.parse((event as MessageEvent<string>).data);
      assert(name === 'edit_item' || name === 'read_timeline');
      if (phase === 'first' && name === 'read_timeline') return; // Keep responseMessages incomplete.
      const binding = { toolCallId, argsDigest, claimId: 'claim-' + toolCallId };
      const claim = await post(base + '/tool-claim', binding);
      assert.equal(claim.status, 200, JSON.stringify(claim.body));
      assert.equal(claim.body.claimed, true);
      counts[name as keyof typeof counts]++;
      if (scenario === 'unknown-write' && phase === 'first') { done.resolve(); return; }
      const settled = await post(base + '/tool-result', { ...binding, result: name === 'edit_item' ? B_RESULT : C_RESULT });
      assert.equal(settled.status, 200, JSON.stringify(settled.body));
      if (until === 'B' && name === 'edit_item') done.resolve();
    }
    stream.addEventListener('tool-request', (event) => {
      const operation = execute(event);
      operations.add(operation);
      void operation.catch(done.reject).finally(() => operations.delete(operation));
    });
    stream.addEventListener('done', (event) => {
      const status = JSON.parse((event as MessageEvent<string>).data).status;
      if (until === 'done' && status === 'completed') done.resolve();
      else done.reject(Error(`Unexpected API terminal status: ${status}`));
    });
    stream.addEventListener('error', (event) => done.reject(Error('API fixture SSE transport failed: ' + ((event as MessageEvent).data ?? 'disconnected'))));
    stream.addEventListener('recovery-blocked', (event) => done.reject(Error('Unexpected freeze: ' + (event as MessageEvent).data)));
    try { await race(done.promise); await race(Promise.all(operations)); }
    catch (error) { throw new Error(`${scenario}/${phase}: ${String(error)}`, { cause: error }); }
    finally { clearTimeout(timer); stream.close(); }
  }
  try {
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    await start('first');
    const created = await post('/api/agent-runs/', { runId, capability, backend: 'api', provider: 'openai',
      openAiApiMode: 'chat', model: 'gpt-4.1', cacheMode: 'short', maxOutputTokens: 4096,
      tools: catalog.edit.filter((tool) => ['edit_item', 'read_timeline'].includes(tool.name)),
      messages: [{ role: 'user', content: 'Edit clip-7 once, then inspect the timeline.' }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const admitted = await post(base + '/start', {});
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    await consume(0, 'B');
    if (scenario === 'completed-round') {
      await race(Promise.race([nextRound.promise, delay(10_000).then(() => { throw Error('The complete first round did not advance'); })]));
    } else {
      const deadline = Date.now() + 5000;
      while (!(await metadata()).recovery.tools.some((tool: { toolCallId: string }) => tool.toolCallId === 'api-1:C')) {
        assert(Date.now() < deadline, 'both tool intents must be present before crashing');
        await delay(10);
      }
    }
    const before = await metadata();
    const saved = checkpoint();
    assert.equal(saved.state, 'inflight');
    assert.equal(saved.index, scenario === 'completed-round' ? 2 : 1);
    assert.equal(JSON.stringify(saved.messages).includes('review-edit-receipt'), scenario === 'completed-round',
      'only complete responseMessages may advance the durable request transcript');
    assert.equal(before.recovery.tools.find((tool: { toolCallId: string }) => tool.toolCallId === 'api-1:B').state,
      scenario === 'unknown-write' ? 'claimed' : 'outcome');
    await stop();
    await start('second');
    const deadline = Date.now() + 40_000;
    for (;;) {
      const state = await metadata();
      assert.equal(state.id, runId);
      assert.equal(state.recovery.state, scenario === 'unknown-write' ? 'waiting_reconcile' : 'ready');
      const response = await post(base + '/start', { mode: 'resume', expectedRevision: state.recovery.revision,
        cursor: before.lastEventId, recorderId: 'api-test-browser' });
      if (scenario === 'unknown-write' && response.status === 409 && /reconcil/i.test(response.body.error)) break;
      if (scenario !== 'unknown-write' && response.status === 202) break;
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.match(response.body.error, /lease/i);
      assert(Date.now() < deadline, 'the dead owner lease expires');
      await delay(500);
    }
    if (scenario === 'unknown-write') {
      const observation = await metadata();
      const opened = Promise.withResolvers<void>();
      const newRequests: string[] = [];
      const stream = openServerRunEventStream({ projectId, runId, capability, after: Math.max(0, observation.firstEventId - 1),
        fetch: (url, init) => fetch(new URL(String(url), origin), { ...init, headers: { ...init?.headers, ...headers() } }) });
      stream.onopen = () => opened.resolve();
      stream.addEventListener('tool-request', (event) => {
        const message = event as MessageEvent<string>;
        if (Number(message.lastEventId) > observation.lastEventId) newRequests.push(JSON.parse(message.data).toolCallId);
      });
      stream.addEventListener('error', () => opened.reject(Error('Unknown-write SSE observation failed')));
      const timer = setTimeout(() => opened.reject(Error('Unknown-write SSE did not open')), 5000);
      try { await opened.promise; await delay(150); assert.deepEqual(newRequests, []); }
      finally { clearTimeout(timer); stream.close(); }
      assert.equal(requests.filter((request) => request.phase === 'second').length, 0);
      assert.deepEqual(counts, { edit_item: 1, read_timeline: 0 });
      assert.equal((await metadata()).recovery.state, 'waiting_reconcile');
    } else {
      if (scenario === 'partial-response') {
        const originalRead = before.recovery.tools.find((tool: { toolCallId: string }) => tool.toolCallId === 'api-1:C');
        const stale = await post(base + '/tool-claim', {
          toolCallId: originalRead.toolCallId, argsDigest: originalRead.argsDigest, claimId: 'stale-browser',
        });
        assert.equal(stale.status, 404, 'old SSE request cannot acquire authority without a new waiter');
        const after = await metadata();
        assert.equal(after.recovery.tools.find((tool: { toolCallId: string }) => tool.toolCallId === 'api-1:C').state, 'intent');
      }
      await consume(before.lastEventId, 'done');
      assert.deepEqual(counts, { edit_item: 1, read_timeline: 1 });
      const final = await metadata();
      assert.equal(final.id, runId);
      assert.equal(final.status, 'completed');
      assert.equal(requests.filter((request) => request.phase === 'second').length, 2);
    }
    console.log(`api-recovery-restart.verify: ${scenario} passed through real provider adapter, proxy, HTTP/SSE and two editor processes`);
  } finally {
    await stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'serve') await serve();
else if (['partial-response', 'unknown-write', 'completed-round'].includes(process.argv[2] ?? '')) await exerciseApiRecoveryRestart(process.argv[2] as Scenario);
else for (const scenario of ['partial-response', 'unknown-write', 'completed-round'] as const) await exerciseApiRecoveryRestart(scenario);
