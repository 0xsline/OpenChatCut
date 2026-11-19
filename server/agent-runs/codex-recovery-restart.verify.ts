import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { openServerRunEventStream } from '../../src/agent/serverRunFetchEventStream.ts';
import { serverRunNeedsResume } from '../../src/agent/serverRunProtocol.ts';

// The Codex stand-in implements the real app-server JSON-RPC dynamic-tool
// protocol. A fresh process gets a new thread/turn and a new model call id.
const fakeCodex = String.raw`#!/usr/bin/env node
const {createInterface} = require('node:readline');
const {join} = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.146.0'); process.exit(0); }
const resumed = __filename.includes('-second.');
const threadId = resumed ? 'thread-second' : 'thread-first';
const turnId = resumed ? 'turn-second' : 'turn-first';
const send = message => process.stdout.write(JSON.stringify(message)+'\n');
const edit = {updates:[{type:'video',itemId:'clip-7',durationInFrames:120}]};
const call = (callId, tool, args) => send({id:'dynamic-'+callId,method:'item/tool/call',
  params:{threadId,turnId,callId,tool,arguments:args}});
createInterface({input:process.stdin}).on('line', raw => {
  const message = JSON.parse(raw);
  if (message.method === 'initialize') {
    if (process.env.CODEX_HOME !== join(__dirname,'.openchatcut','codex')) process.exit(81);
    send({id:message.id,result:{serverInfo:{name:'fake-recovery-codex'}}});
  } else if (message.method === 'initialized') {
    return;
  } else if (message.method === 'thread/start') {
    if (message.params.model !== 'gpt-5.4') process.exit(82);
    if (!['edit_item','read_timeline'].every(name => message.params.dynamicTools?.some(tool => tool.name === name))) process.exit(83);
    send({id:message.id,result:{thread:{id:threadId}}});
  } else if (message.method === 'turn/start') {
    if (resumed && !JSON.stringify(message.params.input).includes('review-edit-receipt')) process.exit(84);
    send({id:message.id,result:{turn:{id:turnId}}});
    call(resumed ? 'B-new' : 'B','edit_item',edit);
  } else if (message.id === 'dynamic-B' || message.id === 'dynamic-B-new') {
    if (message.result?.success !== true || !JSON.stringify(message.result.contentItems).includes('review-edit-receipt')) process.exit(85);
    // The first turn deliberately remains in progress after B. The editor
    // process is killed before it can emit a terminal event or request C.
    if (message.id === 'dynamic-B-new') call('C','read_timeline',{});
  } else if (message.id === 'dynamic-C') {
    if (message.result?.success !== true) process.exit(86);
    send({method:'item/agentMessage/delta',params:{threadId,turnId,delta:'Recovered edit and timeline confirmed.'}});
    send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  } else if (message.method === 'thread/delete' || message.method === 'turn/interrupt') {
    send({id:message.id,result:{}});
  } else {
    send({id:message.id,error:{code:-32601,message:'unsupported test request'}});
  }
}).on('close',()=>process.exit(0));
`;

async function serve(): Promise<void> {
  // Keep Codex's isolated login/runtime directory within this fixture; no
  // user credentials or real Codex installation are touched.
  os.homedir = () => process.env.TEST_RECOVERY_PROFILE!;
  syncBuiltinESMExports();
  const { agentRunsPlugin } = await import('./routes.ts');
  const app = createMiniConnect((error) => { throw error; });
  const configure = agentRunsPlugin().configureServer;
  assert.equal(typeof configure, 'function');
  if (typeof configure !== 'function') throw Error('missing routes');
  configure({ middlewares: app } as never);
  const server = createServer((req, res) => app.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  process.send!(addr.port);
}

export async function exerciseRecoveryRestart(pendingOutcome = false): Promise<void> {
  const backend = 'codex';
  const profile = await mkdtemp(join(tmpdir(), `openchatcut-${backend}-restart-`));
  const cliFor = (phase: string) => join(profile, `test-${backend}-${phase}.${process.platform === 'win32' ? 'cmd' : 'cjs'}`);
  let child: ChildProcess | undefined;
  let origin = '';
  const runId = crypto.randomUUID();
  const projectId = 'resume-test';
  const capability = 'a'.repeat(43);
  const base = '/api/agent-runs/' + runId;
  const metadataPath = base + '?projectId=' + projectId;
  const counts = { edit_item: 0, read_timeline: 0 };
  const headers = () => ({
    Origin: origin, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': capability
  });

  async function start(phase: string) {
    child = fork(fileURLToPath(import.meta.url), ['serve'], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env, OPENCHATCUT_DATA_DIR: profile, TEST_RECOVERY_PROFILE: profile,
        OPENCHATCUT_CODEX_PATH: cliFor(phase),
        OPENCHATCUT_RUN_RECOVERY_DB: join(profile, 'recovery.sqlite'), TEST_RESUME_PHASE: phase
      },
    });
    const [port] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      once(child, 'exit').then(([code, signal]) => { throw Error(`Test server exited before listening: ${code ?? signal}`); }),
    ]);
    origin = 'http://127.0.0.1:' + port;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  async function post(path: string, body: object, allowLeaseWait = false) {
    const response = await fetch(origin + path, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ projectId, ...body }), signal: AbortSignal.timeout(5000)
    });
    const json = await response.json();
    if (allowLeaseWait && response.status === 409 && /lease/.test(json.error)) return null;
    assert.ok(response.ok, path + ' ' + response.status + ' ' + JSON.stringify(json));
    return json;
  }
  async function metadata() {
    const response = await fetch(origin + metadataPath, { headers: headers(), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.json();
  }

  async function consume(after: number, until: 'B' | 'done') {
    const completed = Promise.withResolvers<void>();
    const timer = setTimeout(() => completed.reject(Error('SSE timed out waiting for ' + until)), 12_000);
    const stream = openServerRunEventStream({
      projectId, runId, capability, after,
      fetch: (url, init) => fetch(new URL(String(url), origin), {
        ...init, headers: { ...init?.headers, ...headers() },
      }),
    });
    const operations = new Set<Promise<void>>();
    try {
      async function execute(event: Event) {
        const { toolCallId, argsDigest, name } = JSON.parse((event as MessageEvent<string>).data);
        assert.ok(name === 'edit_item' || name === 'read_timeline');
        const binding = { toolCallId, argsDigest, claimId: 'claim-' + toolCallId };
        assert.ok((await post(base + '/tool-claim', binding)).claimed);
        counts[name as keyof typeof counts]++;
        if (pendingOutcome && toolCallId === 'codex-1:B') { completed.resolve(); return; }
        await post(base + '/tool-result', { ...binding, result: { receipt: 'review-edit-receipt' } });
        if (toolCallId === `codex-1:${until}`) completed.resolve();
      }
      stream.addEventListener('tool-request', event => {
        const operation = execute(event);
        operations.add(operation);
        void operation.catch(completed.reject).finally(() => operations.delete(operation));
      });
      stream.addEventListener('done', event => {
        const status = JSON.parse((event as MessageEvent<string>).data).status;
        if (until === 'done' && status === 'completed') completed.resolve();
        else completed.reject(Error('Unexpected terminal status ' + status));
      });
      stream.addEventListener('error', () => completed.reject(Error('SSE error before ' + until)));
      await completed.promise;
      // The done event can overtake the browser's result HTTP acknowledgement.
      await Promise.all(operations);
    } finally {
      clearTimeout(timer);
      stream.close();
    }
  }

  try {
    for (const phase of ['first', 'second']) {
      const script = join(profile, `test-${backend}-${phase}.cjs`);
      await writeFile(script, fakeCodex, { mode: 0o700 });
      const cli = cliFor(phase);
      if (cli !== script) await writeFile(cli, '@"' + process.execPath + '" "' + script + '" %*\r\n');
    }
    await start('first');
    await post('/api/agent-runs/', {
      runId, capability, cacheMode: 'short', backend, model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Edit clip-7 once then read the timeline.' }], maxOutputTokens: 4096
    });
    await post(base + '/start', {});
    await consume(0, 'B');
    const before = await metadata();
    assert.equal(serverRunNeedsResume(before), false, JSON.stringify(before));
    assert.equal(before.recovery.tools.find((t: { toolCallId: string }) => t.toolCallId === 'codex-1:B')?.state, pendingOutcome ? 'claimed' : 'outcome');
    await stop();
    await start('second');
    if (pendingOutcome) {
      const state = await metadata();
      assert.equal(state.id, runId);
      assert.equal(state.recovery?.state, 'waiting_reconcile');
      const deadline = Date.now() + 40_000;
      for (;;) {
        const current = await metadata();
        assert.equal(current.recovery.state, 'waiting_reconcile');
        const response = await fetch(origin + base + '/start', { method: 'POST', headers: headers(),
          body: JSON.stringify({ projectId, mode: 'resume', expectedRevision: current.recovery.revision,
            cursor: before.lastEventId, recorderId: 'test-browser' }), signal: AbortSignal.timeout(5000) });
        const rejected = await response.json();
        assert.equal(response.status, 409, JSON.stringify(rejected));
        if (/reconcil/i.test(rejected.error)) break;
        assert.match(rejected.error, /lease/i);
        assert.ok(Date.now() < deadline, 'unknown outcome must still reject recovery after the dead lease expires');
        await delay(500);
      }
      const observation = await metadata();
      let toolRequests = 0;
      const historicalRequests: string[] = [];
      const opened = Promise.withResolvers<void>();
      const stream = openServerRunEventStream({ projectId, runId, capability, after: Math.max(0, observation.firstEventId - 1),
        fetch: (url, init) => fetch(new URL(String(url), origin), {
          ...init, headers: { ...init?.headers, ...headers() },
        }) });
      const errors: string[] = [];
      stream.onopen = () => opened.resolve();
      stream.addEventListener('tool-request', (event) => {
        const message = event as MessageEvent<string>;
        if (Number(message.lastEventId) > observation.lastEventId) toolRequests++;
        else historicalRequests.push(JSON.parse(message.data).toolCallId);
      });
      stream.addEventListener('error', () => { errors.push('unexpected SSE failure'); opened.resolve(); });
      const openingTimeout = setTimeout(() => opened.reject(Error('Blocked-run SSE did not open')), 5000);
      try {
        await opened.promise;
        await delay(250);
        assert.deepEqual(errors, []);
        assert(historicalRequests.includes('codex-1:B'), 'observe the retained request without executing its replay');
        assert.equal(toolRequests, 0, 'a claimed unknown effect cannot be redispatched through SSE');
      } finally { clearTimeout(openingTimeout); stream.close(); }
      assert.deepEqual(counts, { edit_item: 1, read_timeline: 0 });
      const unchanged = await metadata();
      assert.equal(unchanged.recovery.state, 'waiting_reconcile');
      assert.equal(unchanged.recovery.tools.find((tool: { toolCallId: string }) => tool.toolCallId === 'codex-1:B')?.state, 'claimed');
      console.log(`${backend}-recovery-restart.verify: claimed unknown effect stays frozen after process restart, no second browser execution`);
      return;
    }
    const deadline = Date.now() + 40_000;
    for (; ;) {
      const state = await metadata();
      assert.equal(state.recovery?.state, 'ready');
      assert.ok(!['failed', 'completed', 'cancelled'].includes(state.status));
      const response = await post(base + '/start', {
        mode: 'resume', expectedRevision: state.recovery.revision,
        cursor: before.lastEventId, recorderId: 'test-browser',
      }, true);
      if (response) {
        assert.equal(response.outcome, 'started');
        break;
      }
      assert.ok(Date.now() < deadline, 'old executor lease expires');
      await delay(500);
    }
    await consume(before.lastEventId, 'done');
    assert.deepEqual(counts, { edit_item: 1, read_timeline: 1 });
    const finished = await metadata();
    assert.equal(finished.id, runId, 'completion belongs to the original run');
    assert.equal(finished.status, 'completed');
    console.log(`${backend}-recovery-restart.verify: real HTTP/SSE restart, B -> crash -> B-new reused -> C, each browser tool executed once on the same run`);
  } finally { await stop(); await rm(profile, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'serve') await serve();
  else {
    await exerciseRecoveryRestart();
    await exerciseRecoveryRestart(true);
  }
}
