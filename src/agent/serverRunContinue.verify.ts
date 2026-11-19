import assert from 'node:assert/strict';
import type { DisplayMessage } from './agent-session.ts';
import type { ServerRunSendEnvironment } from './serverRunSend.ts';
import { configureSharedKvBackend } from '../persist/sharedKv.ts';
import { emptyProjectDoc } from './tools/project-tools.ts';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  locks: { request: async (_key: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({}) },
} });
const memory = new Map<string, unknown>();
configureSharedKvBackend({ get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, value); },
  del: async (key: string) => { memory.delete(key); }, keys: async () => [...memory.keys()],
} as never);
const { sendServerRun } = await import('./serverRunSend.ts');
const { saveStoredServerRun, readStoredServerRun, patchStoredServerRun } = await import('./serverRunSessionStorage.ts');
const { releaseServerRunOwnership } = await import('./serverRunOwnership.ts');
const { restoreContinuationMessages } = await import('./serverRunPause.ts');
const { SERVER_RUN_CAPABILITY_HEADER, buildServerRunPayload } = await import('./serverRunProtocol.ts');
const doc = emptyProjectDoc();
const projectId = 'continue-browser';
const runId = 'same-logical-run';
const originalFetch = globalThis.fetch;
let blocked = false;
let loseResponse = false;
let loseMetadata = false;
let restored = 0;
let subscribed = 0;
let recoveries = 0;
let posts: Record<string, unknown>[] = [];
let lastContinuationId: string | null = null;
function setup() {
  blocked = false; loseResponse = false; loseMetadata = false; restored = 0; subscribed = 0; recoveries = 0; posts = []; lastContinuationId = null;
  saveStoredServerRun(projectId, { projectId, runId, capability: 'original-capability', paused: true,
    text: '剪一个短片', content: '剪一个短片', cursor: 9, assistantText: '已完成前半段',
    activeToolNames: buildServerRunPayload(projectId, '剪一个短片', {}, { cacheMode: 'short', maxOutputTokens: 4096 }).tools.map((tool) => tool.name), attempts: [] });
  const messages: DisplayMessage[] = [{ role: 'user', text: '剪一个短片' }, { role: 'assistant', text: '已完成前半段' }];
  const ref = <T>(current: T) => ({ current });
  const environment = { projectId, refs: { enabled: ref(true), ready: ref(true), running: ref(false),
    runId: ref<string | null>(runId), runProject: ref(projectId), capability: ref('original-capability'),
    context: ref({ getDoc: () => doc }), options: ref({ onRunStart: async (input: { runId: string }) => {
      assert.equal(input.runId, runId); restored++; return { tools: [], draftDoc: doc, baseDoc: doc };
    } }), settings: ref({}), abort: ref(null), cursor: ref(9), assistantText: ref('已完成前半段'),
    assistantThinking: ref(''), terminalRun: ref(null), staleRecoveryRun: ref(null) },
    setRunning: () => undefined,
    updateMessages: (update: (current: DisplayMessage[]) => DisplayMessage[]) => { messages.splice(0, messages.length, ...update(messages)); },
    appendMessage: (message: DisplayMessage) => { messages.push(message); },
    toolExecutor: { start: () => undefined, stop: () => undefined },
    subscribe: (id: string) => { assert.equal(id, runId); subscribed++; },
    scheduleRecovery: (id: string) => { assert.equal(id, runId); recoveries++; },
  } as unknown as ServerRunSendEnvironment;
  return { environment, messages };
}
globalThis.fetch = async (url, init) => {
  const path = String(url);
  assert.notEqual(path, '/api/agent-runs/', 'continuation must never create a new run');
  if (path.endsWith('/start')) {
    const body = JSON.parse(String(init?.body));
    posts.push(body);
    assert.equal(restored > 0, true, 'restore draft before continuation authority');
    assert.equal(readStoredServerRun(projectId)?.pendingContinuation?.id, body.continuationId,
      'idempotency id is durable before HTTP');
    assert.equal(new Headers(init?.headers).get(SERVER_RUN_CAPABILITY_HEADER), 'original-capability');
    assert.equal(body.mode, 'continue');
    assert.equal(body.projectId, projectId);
    lastContinuationId = body.continuationId;
    if (loseResponse) { loseResponse = false; throw new Error('response lost'); }
    return Response.json({ ok: true, outcome: 'started', mode: 'continue', continuationId: body.continuationId,
      attemptNumber: 2, revision: 8 }, { status: 202 });
  }
  if (loseMetadata) throw new Error('network down');
  return Response.json({ status: lastContinuationId ? 'running' : 'paused', firstEventId: 1, lastEventId: 9,
    recovery: { state: lastContinuationId ? 'active' : 'paused', revision: 7, attemptNumber: 1,
      lastContinuationId,
      tools: blocked ? [{ toolCallId: 'unknown-write', name: 'edit_item', argsDigest: 'digest', state: 'claimed' }] : [] } });
};
try {
  const first = setup();
  await sendServerRun(first.environment, '继续，字幕英文');
  assert.equal(posts.length, 1, JSON.stringify(first.messages));
  assert.equal(posts[0].message, '继续，字幕英文');
  assert.equal(subscribed, 1);
  assert.equal(readStoredServerRun(projectId)?.runId, runId);
  assert.equal(readStoredServerRun(projectId)?.cursor, 9, 'continuation retains the SSE cursor');
  assert.match(readStoredServerRun(projectId)!.content!, /剪一个短片[\s\S]*继续，字幕英文/);
  assert.equal(first.messages.filter((message) => message.role === 'user' && message.text === '继续，字幕英文').length, 1);
  const restoredMessages = restoreContinuationMessages(first.messages, readStoredServerRun(projectId)!);
  assert.equal(restoredMessages.filter((message) => message.continuationId).length, 1, 'hydration does not duplicate the user turn');
  first.environment.refs.running.current = false;
  patchStoredServerRun(projectId, { paused: true, assistantText: '字幕已生成' });
  lastContinuationId = null;
  await sendServerRun(first.environment, '再把片尾缩短');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].continuationId, posts[1].continuationId);
  assert.equal(readStoredServerRun(projectId)?.continuationTurns?.length, 2);
  assert.match(readStoredServerRun(projectId)!.content!, /剪一个短片[\s\S]*继续，字幕英文[\s\S]*再把片尾缩短/);
  const { finishRecoveredRun } = await import('./serverRunRecovery.ts');
  let committedContent = '';
  await finishRecoveredRun({ projectId, runId, status: 'completed', assistantText: '完成',
    onTerminal: () => 'finalized',
    commitModelTurn: async (_id, _length, content) => { committedContent = content; },
  });
  assert.match(committedContent, /剪一个短片[\s\S]*继续，字幕英文[\s\S]*再把片尾缩短/,
    'the final conversation commit retains all continuation instructions');
  releaseServerRunOwnership(projectId, runId);
  await Promise.resolve();

  const unknown = setup(); blocked = true;
  await sendServerRun(unknown.environment, '继续，字幕英文');
  assert.equal(posts.length, 0, 'an unknown write claim prevents /start and /create');
  assert.equal(restored, 0);
  assert(readStoredServerRun(projectId));

  const lost = setup(); loseResponse = true;
  await sendServerRun(lost.environment, '继续，字幕英文');
  assert.equal(posts.length, 1);
  assert.equal(subscribed, 1, 'durable lastContinuationId acknowledges a lost HTTP response');
  assert.equal(readStoredServerRun(projectId)?.pendingContinuation, undefined);
  assert.equal(lost.messages.filter((message) => message.continuationId).length, 1);
  releaseServerRunOwnership(projectId, runId);
  await Promise.resolve();

  const completed = setup(); loseResponse = true;
  const runningFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await runningFetch(url, init);
    if (lastContinuationId && !String(url).endsWith('/start')) {
      const metadata = await response.json();
      return Response.json({ ...metadata, status: 'completed', recovery: { ...metadata.recovery, state: 'finalized' } });
    }
    return response;
  };
  await sendServerRun(completed.environment, '继续，字幕英文');
  assert.equal(posts.length, 1, 'completion during a lost response never dispatches another attempt');
  assert.equal(subscribed, 1, 'terminal events are consumed so final draft/history settlement still happens');
  assert.equal(readStoredServerRun(projectId)?.pendingContinuation, undefined);
  assert.equal(completed.messages.filter((message) => message.continuationId).length, 1);
  releaseServerRunOwnership(projectId, runId);
  await Promise.resolve();
  globalThis.fetch = runningFetch;

  const lateCompletion = setup();
  const unsentAfterCompletion = '  改成 15 秒\n保留英文字幕  ';
  globalThis.fetch = async (_url, init) => {
    assert.notEqual(init?.method, 'POST', 'recovering a completed run must not dispatch an unsent instruction');
    return Response.json({ status: 'completed', recovery: { state: 'finalized', revision: 8 } });
  };
  await sendServerRun(lateCompletion.environment, unsentAfterCompletion);
  assert.equal(posts.length, 0);
  assert.equal(recoveries, 1);
  assert(lateCompletion.messages.some((message) => message.role === 'note'
    && message.text.includes('尚未发送') && message.text.includes(unsentAfterCompletion)),
  'a message typed before discovering completion remains visible verbatim');
  assert.equal(readStoredServerRun(projectId)?.pendingContinuation, undefined);

  const alreadyAccepted = setup();
  const pending = { id: 'accepted-in-flight', text: '上一条继续指令', message: '上一条继续指令', previousAssistantText: '' };
  patchStoredServerRun(projectId, { pendingContinuation: pending, continuationTurns: [pending] });
  const unsentDifferentInstruction = '  这条新指令还需要处理\n再改片尾  ';
  globalThis.fetch = async (_url, init) => {
    assert.notEqual(init?.method, 'POST', 'checking an accepted instruction must not dispatch the different instruction');
    return Response.json({ status: 'running', recovery: { state: 'active', revision: 8, lastContinuationId: pending.id } });
  };
  await sendServerRun(alreadyAccepted.environment, unsentDifferentInstruction);
  assert.equal(posts.length, 0);
  assert.equal(recoveries, 1);
  assert(alreadyAccepted.messages.some((message) => message.role === 'note'
    && message.text.includes('尚未发送') && message.text.includes(unsentDifferentInstruction)),
  'a different instruction remains visible while recovering an already accepted instruction');
  assert.equal(readStoredServerRun(projectId)?.pendingContinuation, undefined);
  assert.equal(readStoredServerRun(projectId)?.continuationTurns?.length, 1,
    'the unsent instruction is not recorded as an accepted continuation');
  globalThis.fetch = runningFetch;

  const retry = setup();
  const successfulFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/start') && posts.length === 0) {
      loseResponse = true;
      try { return await successfulFetch(url, init); }
      finally { lastContinuationId = null; loseMetadata = true; }
    }
    return successfulFetch(url, init);
  };
  await sendServerRun(retry.environment, '继续，字幕英文');
  const id = readStoredServerRun(projectId)?.pendingContinuation?.id;
  assert(id, 'uncertain acceptance preserves the pending instruction');
  loseMetadata = false;
  await sendServerRun(retry.environment, '继续，字幕英文');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].continuationId, id, 'retry uses the original idempotency id');
  assert.equal(retry.messages.filter((message) => message.continuationId).length, 1);
  assert.equal(readStoredServerRun(projectId)?.continuationTurns?.length, 1);
  releaseServerRunOwnership(projectId, runId);
} finally { globalThis.fetch = originalFetch; }
console.log('serverRunContinue.verify: same-run send, restore-before-start, unknown-claim gate and durable idempotent retry passed');
