import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openServerRunEventStream } from '../../src/agent/serverRunFetchEventStream';
import catalog from '../../assets/agent/openchatcut-tool-schemas.json';

const NEW_MESSAGE = 'Continue and use English subtitles.';
const B_RESULT = { receipt: 'continuation-edit-receipt', applied: true, revision: 7 };
const C_RESULT = [{ itemId: 'clip-7', durationInFrames: 120, subtitleLanguage: 'English' }];
const DRAFT = JSON.stringify({ projectId: 'continuation-project', revision: 7, editReceipt: B_RESULT.receipt });
type Backend = 'api' | 'codex';
type Metadata = { id: string; status: string; lastEventId: number; recovery: {
  state: string; revision: number; attemptNumber: number; lastError: unknown; lastContinuationId: string | null;
  tools: Array<{ toolCallId: string; state: string; result?: unknown }>;
} };
type ProviderMessage = { role: string; content?: string; tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
type ProviderRequest = { messages: ProviderMessage[]; tools: unknown[]; stream: boolean };

function answer(res: ServerResponse, call?: { id: string; name: string; args: object }): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = { id: 'continuation-chat', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1',
    choices: [{ index: 0, delta: call ? { role: 'assistant', tool_calls: [{ index: 0, id: call.id,
      type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
      : { role: 'assistant', content: 'English subtitles confirmed.' }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

export async function exerciseContinuation(backend: Backend, unknownClaim = false): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), `openchatcut-continuation-${backend}-`));
  const runId = crypto.randomUUID();
  const continuationId = crypto.randomUUID();
  const projectId = 'continuation-project';
  const artifactId = 'srd_continuation_01';
  const capability = 'c'.repeat(43);
  const base = '/api/agent-runs/' + runId;
  const counts = { edit_item: 0, read_timeline: 0 };
  const providerRequests: ProviderRequest[] = [];
  const failure = Promise.withResolvers<never>();
  void failure.promise.catch(() => undefined);
  const reachedC = Promise.withResolvers<void>();
  const releaseC = Promise.withResolvers<void>();
  const claimedB = Promise.withResolvers<void>();
  const pending = new Set<Promise<void>>();
  const streams: ReturnType<typeof openServerRunEventStream>[] = [];
  let child: ChildProcess | undefined;
  let origin = '';
  let continuing = false;
  let continuationRequests = 0;
  const provider = createServer((req, res) => {
    void (async () => {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer continuation-fixture-key');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest;
      assert.equal(body.stream, true);
      providerRequests.push(body);
      if (!continuing) {
        if (providerRequests.length === 1) {
          answer(res, { id: 'B', name: 'edit_item', args: { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 120 }] } });
          return;
        }
        assert.equal(providerRequests.length, 2, 'a deterministic HTTP 400 must not retry');
        assert(body.messages.some(message => message.role === 'tool' && message.content?.includes(B_RESULT.receipt)),
          'the failing provider request already contains B result');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Explicit continuation fixture provider failure', type: 'invalid_request_error' } }));
        return;
      }
      continuationRequests += 1;
      assert(JSON.stringify(body.messages).includes(NEW_MESSAGE), 'the real API adapter receives the new user instruction');
      const preservedB = body.messages.find(message => message.role === 'tool' && message.content?.includes(B_RESULT.receipt));
      assert(preservedB, 'the real API adapter receives the confirmed B result');
      assert(body.messages.some(message => message.role === 'assistant'
        && message.tool_calls?.some(call => call.id === preservedB.tool_call_id)), 'B keeps its assistant/tool pairing');
      if (continuationRequests === 1) answer(res, { id: 'C', name: 'read_timeline', args: {} });
      else {
        assert.equal(continuationRequests, 2, 'continuation completes in one tool round without another attempt');
        assert(body.messages.some(message => message.role === 'tool' && message.content?.includes('subtitleLanguage')));
        answer(res);
      }
    })().catch(error => { failure.reject(error); if (!res.writableEnded) { res.writeHead(500); res.end('fixture assertion failed'); } });
  });
  const race = <T>(promise: Promise<T>) => Promise.race([promise, failure.promise]);
  const headers = () => ({ Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
    'X-OpenChatCut-Run-Capability': capability });
  async function startEditor(): Promise<void> {
    const address = provider.address();
    assert(address && typeof address === 'object');
    child = fork(fileURLToPath(new URL('./continuation-editor.fixture.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], env: {
        PATH: dirname(process.execPath) + ':' + process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test',
        OPENCHATCUT_DATA_DIR: profile, OPENCHATCUT_RUN_RECOVERY_DB: join(profile, 'recovery.sqlite'),
        TEST_CONTINUATION_PROFILE: profile, TEST_PROVIDER_ORIGIN: 'http://127.0.0.1:' + address.port,
        OPENCHATCUT_CODEX_PATH: join(profile, 'continuation-codex.cjs'),
      },
    });
    const [port] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      once(child, 'exit').then(([code, signal]) => { throw Error(`Continuation editor exited before listening: ${code ?? signal}`); }),
    ]);
    origin = 'http://127.0.0.1:' + port;
  }
  async function stopEditor(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  async function post(path: string, body: object) {
    const response = await fetch(origin + path, { method: 'POST', headers: headers(),
      body: JSON.stringify({ projectId, ...body }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  async function metadata(): Promise<Metadata> {
    const response = await fetch(origin + base + '?projectId=' + projectId, { headers: headers(), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function evidence() {
    const response = await fetch(`${origin}/fixture/evidence?projectId=${projectId}&runId=${runId}&artifactId=${artifactId}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function waitForStatus(status: string): Promise<Metadata> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const state = await race(metadata());
      if (state.status === status && (status !== 'paused' || state.recovery.state === 'paused')) return state;
      assert(!['failed', 'cancelled', 'completed'].includes(state.status), `expected ${status}, got ${JSON.stringify(state)}`);
      assert(Date.now() < deadline, `timed out waiting for ${status}: ${JSON.stringify(state)}`);
      await delay(20);
    }
  }
  function observe(after: number) {
    const stream = openServerRunEventStream({ projectId, runId, capability, after,
      fetch: (url, init) => fetch(new URL(String(url), origin), { ...init, headers: { ...init?.headers, ...headers() } }) });
    streams.push(stream);
    stream.addEventListener('tool-request', event => {
      const task = (async () => {
        const { toolCallId, argsDigest, name } = JSON.parse((event as MessageEvent<string>).data);
        assert(name === 'edit_item' || name === 'read_timeline');
        const binding = { toolCallId, argsDigest, claimId: 'claim-' + toolCallId };
        const claim = await post(base + '/tool-claim', binding);
        assert.equal(claim.status, 200, JSON.stringify(claim.body));
        assert.equal(claim.body.claimed, true);
        counts[name as keyof typeof counts]++;
        if (name === 'edit_item') {
          const saved = await post(base + '/draft', { artifact: { artifactId, body: DRAFT, redacted: false, binaryOmitted: false } });
          assert.equal(saved.status, 200, JSON.stringify(saved.body));
          if (unknownClaim) { claimedB.resolve(); return; }
        } else {
          reachedC.resolve();
          await releaseC.promise;
        }
        const settled = await post(base + '/tool-result', { ...binding, result: name === 'edit_item' ? B_RESULT : C_RESULT });
        assert.equal(settled.status, 200, JSON.stringify(settled.body));
      })();
      pending.add(task);
      void task.catch(failure.reject).finally(() => pending.delete(task));
    });
    return stream;
  }
  try {
    await copyFile(new URL('./continuation-codex.fixture.cjs', import.meta.url), join(profile, 'continuation-codex.cjs'));
    await chmod(join(profile, 'continuation-codex.cjs'), 0o700);
    // This fixture never reads .env or the user's ~/.codex directory.
    await writeFile(join(profile, 'fixture-profile'), 'isolated');
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    await startEditor();
    const created = await post('/api/agent-runs/', { runId, capability, backend, provider: 'openai',
      model: backend === 'api' ? 'gpt-4.1' : 'gpt-5.4', openAiApiMode: 'chat', cacheMode: 'short', maxOutputTokens: 4096,
      tools: catalog.edit.filter(tool => ['edit_item', 'read_timeline'].includes(tool.name)),
      messages: [{ role: 'user', content: 'Edit clip-7 once, then inspect the timeline.' }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const firstStream = observe(0);
    assert.equal((await post(base + '/start', {})).status, 202);
    if (unknownClaim) {
      await race(Promise.race([claimedB.promise, delay(10_000).then(() => { throw Error('B was never claimed'); })]));
      firstStream.close();
      await stopEditor();
      await startEditor();
      const state = await metadata();
      assert.equal(state.recovery.state, 'waiting_reconcile');
      const rejected = await post(base + '/start', { mode: 'continue', expectedRevision: state.recovery.revision, continuationId, message: NEW_MESSAGE });
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal((await metadata()).recovery.tools.find(tool => tool.state === 'claimed')?.state, 'claimed');
      assert.deepEqual(counts, { edit_item: 1, read_timeline: 0 });
      assert.equal(providerRequests.length, 1, 'unknown browser effects never dispatch a continuation provider request');
      console.log('run-continuation.verify: claimed unknown outcome blocks explicit continuation');
      return;
    }
    const paused = await waitForStatus('paused');
    assert.equal(paused.recovery.state, 'paused');
    assert.equal(paused.recovery.attemptNumber, 1);
    assert(paused.recovery.lastError, 'the pause preserves the provider error');
    assert.equal(paused.id, runId);
    assert.deepEqual(counts, { edit_item: 1, read_timeline: 0 });
    let saved = await evidence();
    assert.equal(saved.artifact.body, DRAFT, 'pause retains the latest browser draft');
    assert(saved.recovery.executionInput, 'pause retains the execution input');
    assert(saved.recovery.tools.some((tool: { state: string; result: unknown }) => tool.state === 'outcome'
      && JSON.stringify(tool.result).includes(B_RESULT.receipt)), 'pause retains B outcome');
    assert(!saved.events.some((event: { type: string }) => event.type === 'done'), 'pause emits no final done');
    firstStream.close();
    // API proves a paused continuation survives a full editor restart.
    if (backend === 'api') {
      assert.equal(providerRequests.length, 2, 'HTTP 400 was reported once without automatic retry');
      await stopEditor();
      await startEditor();
      const restored = await metadata();
      assert.equal(restored.status, 'paused');
      assert.equal(restored.recovery.state, 'paused');
      saved = await evidence();
      assert.equal(saved.artifact.body, DRAFT);
      assert(saved.recovery.executionInput);
      assert(saved.recovery.tools.some((tool: { state: string; result: unknown }) => tool.state === 'outcome'
        && JSON.stringify(tool.result).includes(B_RESULT.receipt)), 'restart preserves the confirmed B outcome');
      assert(!saved.events.some((event: { type: string }) => event.type === 'done'));
    }
    const before = await metadata();
    continuing = true;
    observe(before.lastEventId);
    const body = { mode: 'continue', expectedRevision: before.recovery.revision, continuationId, message: NEW_MESSAGE };
    const accepted = await post(base + '/start', body);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.body.outcome, 'started');
    assert.equal(accepted.body.mode, 'continue');
    assert.equal(accepted.body.continuationId, continuationId);
    assert.equal(accepted.body.attemptNumber, 2);
    assert.equal(typeof accepted.body.revision, 'number');
    assert.equal((await metadata()).id, runId, 'the original run and capability continue');
    await race(Promise.race([reachedC.promise, delay(10_000).then(() => { throw Error('continued provider did not request C'); })]));
    const duplicate = await post(base + '/start', body);
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.outcome, 'duplicate');
    assert.equal(duplicate.body.attemptNumber, 2);
    const conflicting = await post(base + '/start', { ...body, message: 'A different continuation instruction.' });
    assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));
    releaseC.resolve();
    const finished = await waitForStatus('completed');
    await race(Promise.all(pending));
    assert.equal(finished.id, runId);
    assert.equal(finished.recovery.attemptNumber, 2);
    assert.equal(finished.recovery.lastContinuationId, continuationId);
    assert.deepEqual(counts, { edit_item: 1, read_timeline: 1 }, 'B is preserved and only C executes after continuation');
    const completedDuplicate = await post(base + '/start', body);
    assert.equal(completedDuplicate.status, 200, JSON.stringify(completedDuplicate.body));
    assert.equal(completedDuplicate.body.outcome, 'duplicate', 'retry after completion still acknowledges the same continuation');
    assert.equal(completedDuplicate.body.attemptNumber, 2);
    saved = await evidence();
    assert.equal(saved.events.filter((event: { type: string }) => event.type === 'done').length, 1,
      'the same run emits exactly one final done after continuation completes');
    if (backend === 'codex') {
      const turns = (await readFile(join(profile, 'codex-inputs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(turns.length, 2, 'one new Codex thread starts for the explicit continuation');
      assert.notEqual(turns[0].threadId, turns[1].threadId);
      assert(turns[1].input.includes(NEW_MESSAGE));
      assert(turns[1].input.includes(B_RESULT.receipt));
    } else assert.equal(continuationRequests, 2);
    console.log(`run-continuation.verify: ${backend} B -> explicit provider error -> paused${backend === 'api' ? ' -> editor restart' : ''} -> new message -> same run C, exactly once`);
  } finally {
    releaseC.resolve();
    for (const stream of streams) stream.close();
    await Promise.allSettled(pending);
    await stopEditor();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}
const selected = process.argv[2];
if (selected === 'api' || selected === 'codex') await exerciseContinuation(selected);
else if (selected === 'unknown-claim') await exerciseContinuation('api', true);
else {
  await exerciseContinuation('api');
  await exerciseContinuation('codex');
  await exerciseContinuation('api', true);
}
