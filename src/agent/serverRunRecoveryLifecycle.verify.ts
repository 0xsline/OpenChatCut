import assert from 'node:assert/strict';
import { emptyProjectDoc } from './tools/project-tools.ts';
import type { DisplayMessage } from './agent-session.ts';
import type { ServerRunMetadata } from './serverRunProtocol.ts';
import type { ServerRunState } from './serverRunState.ts';
import type { ServerRunRecoveryPreparation } from './serverRunRecoveryPreparation.ts';
import { revisionOf } from './external-edit-session.ts';
import { restoreToolActions } from './serverRunProposalLifecycle.ts';
import type { ServerRunDraft } from './serverRunDraftStore.ts';
import { collectRunEvidence, reconcileRunEvidence } from './serverRunToolReconcileClient.ts';
import { continueActiveRecovery, finishLocalTerminal } from './serverRunRecoveryLifecycle.ts';
import { adoptServerRunBaseline } from './serverRunRecoveryBaseline.ts';
import { openSubscription, bindEventSource } from './serverRunStreamLifecycle.ts';
import { endFrozenServerRun, recheckFrozenServerRun } from './useServerRunFreezeActions.ts';
import { saveStoredServerRun, readStoredServerRun } from './serverRunSessionStorage.ts';
import { configureSharedKvBackend } from '../persist/sharedKv.ts';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
const memory = new Map<string, unknown>();
configureSharedKvBackend({ get: async (key: string) => memory.get(key),
  set: async (key: string, value: unknown) => { memory.set(key, value); },
  del: async (key: string) => { memory.delete(key); }, keys: async () => [...memory.keys()],
} as never);
const projectId = 'browser-recovery-lifecycle';
const runId = 'run-browser-recovery';
const doc = emptyProjectDoc();
const originalFetch = globalThis.fetch;
let metadata: ServerRunMetadata;
let requests: string[] = [];
let settlementFails = false;
let browserReady: (() => boolean) | undefined;
globalThis.fetch = async (url, init) => {
  const path = String(url);
  requests.push(path);
  if (path.endsWith('/tool-result')) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.argsDigest, 'digest-1');
    assert.deepEqual(body.result, { applied: true });
    assert.equal(typeof body.claimId, 'string');
    metadata = { ...metadata, recovery: { state: 'ready', revision: 8,
      tools: [{ toolCallId: 'call-1', name: 'edit_item', argsDigest: 'digest-1', state: 'outcome', result: body.result }] } };
    return Response.json({ ok: true });
  }
  if (path.endsWith('/start')) {
    assert.equal(browserReady?.(), true, 'browser draft and executor must be ready before starting the model');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.mode, 'resume');
    assert.equal(body.expectedRevision, 8, 'resume uses the revision after acknowledging existing results');
    return Response.json({ ok: true }, { status: 202 });
  }
  if (path.endsWith('/settle')) {
    if (settlementFails) return Response.json({ error: 'unavailable' }, { status: 503 });
    assert.equal(JSON.parse(String(init?.body)).status, 'interrupted');
    return Response.json({ ok: true });
  }
  if (path.includes('/api/agent-runs/') && !path.includes('/events')) return Response.json(metadata);
  throw new Error(`Unexpected fetch: ${path}`);
};

function setup() {
  requests = [];
  const messages: DisplayMessage[] = [{ role: 'user', text: 'edit' }, { role: 'assistant', text: 'partial' }];
  const calls = { executorStarts: 0, executorStops: 0, subscriptions: 0, closes: 0, recovered: 0, attaches: 0 };
  const ref = <T>(current: T) => ({ current });
  const state = {
    refs: { enabled: ref(true), ready: ref(true), running: ref(true), runId: ref<string | null>(runId),
      runProject: ref<string | null>(projectId), capability: ref<string | null>('capability'),
      frozenRun: ref<string | null>(null), terminalRun: ref<string | null>(null),
      finalizingRun: ref<string | null>(null), runExecutor: ref<unknown>(null),
      activeOptions: ref<unknown>(null), abort: ref<AbortController | null>(new AbortController()),
      cursor: ref(2), assistantText: ref('partial'), assistantThinking: ref('old thinking'),
      context: ref({ getDoc: () => doc }),
      options: ref({ onRunStart: async () => ({ tools: [] }) }),
      recover: ref(async () => { calls.recovered++; }),
    },
    setRunning: (_running: boolean) => undefined,
    setLiveTool: () => undefined,
    updateMessages: (update: (current: DisplayMessage[]) => DisplayMessage[]) => { messages.splice(0, messages.length, ...update(messages)); },
    appendMessage: (message: DisplayMessage) => { messages.push(message); },
    eventSession: { close: () => { calls.closes++; }, resetRecovery: () => undefined,
      isCurrent: () => true, attach: (source: { close(): void }) => { calls.attaches++; source.close(); return false; } },
    toolExecutor: { start: () => { calls.executorStarts++; }, stop: () => { calls.executorStops++; },
      reconcileStoredAttempts: () => assert.fail('Recovery must never manufacture outcomes via the legacy path') },
  } as unknown as ServerRunState;
  saveStoredServerRun(projectId, { projectId, runId, capability: 'capability', text: 'edit', content: 'edit',
    cursor: 2, assistantText: 'partial', attempts: [] });
  const stream = { subscribe: () => { calls.subscriptions++; },
    finishRun: async () => undefined, scheduleRecovery: () => assert.fail('resume must reach the coordinator'),
    abandonStaleRecovery: () => assert.fail('credentials must be retained') };
  const context = () => ({ projectId, stored: readStoredServerRun(projectId)!, state, stream, alive: { current: true } });
  const prepared = (): Extract<ServerRunRecoveryPreparation, { kind: 'active' }> => ({
    kind: 'active', capability: 'capability', cursor: 2, metadata, activation: {} as never,
    resume: { revision: metadata.recovery!.revision },
  });
  return { state, calls, messages, stream, context, prepared };
}

try {
  metadata = { status: 'running', firstEventId: 1, lastEventId: 2, recovery: {
    state: 'waiting_reconcile', revision: 7,
    tools: [{ toolCallId: 'call-1', name: 'edit_item', argsDigest: 'digest-1', state: 'claimed' }],
  } };
  const claimed = collectRunEvidence(metadata, null, [], doc);
  assert.equal(claimed.blocked, true, 'durable-only claimed tool is found even without a local draft');
  const intent = collectRunEvidence({ ...metadata, recovery: { state: 'ready', revision: 7,
    tools: [{ toolCallId: 'call-1', name: 'edit_item', argsDigest: 'digest-1', state: 'intent' }] } }, null, [], doc);
  assert.equal(intent.blocked, false, 'intent without authority is safe to resume');

  const storedError = collectRunEvidence(metadata, null, [{ toolCallId: 'call-1', argsDigest: 'digest-1',
    name: 'edit_item', status: 'error', error: 'clip missing' }], doc);
  assert.equal(storedError.blocked, false, 'a recorded business failure is an outcome that can be submitted');
  assert.equal(storedError.existingOutcomes[0]?.error, 'clip missing');

  const localTool = { version: 1 as const, kind: 'tool' as const,
    toolCallId: 'call-1', name: 'edit_item', argsDigest: 'digest-1', args: {},
    result: { applied: true }, actions: [{ type: 'trim', itemId: 'clip-1' } as never] };
  const draft: ServerRunDraft = { base: { version: 1, kind: 'base', text: 'edit', content: 'edit',
    askOnly: false, references: [], baseDoc: doc }, tools: [localTool] };
  const changedDoc = { ...doc, activeTimelineId: 'externally-edited' };
  const savedResult = [{ toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item',
    status: 'result' as const, result: { applied: true } }];
  const unmarkedCommit = collectRunEvidence(metadata, draft, savedResult, changedDoc);
  assert.equal(unmarkedCommit.blocked, true, 'a saved result cannot prove an unmarked live commit did not occur');
  assert.equal(unmarkedCommit.existingOutcomes.length, 0, 'ambiguous landing must block result submission');
  const acknowledged = { ...metadata, recovery: { ...metadata.recovery!, state: 'ready' as const,
    tools: [{ ...metadata.recovery!.tools![0]!, state: 'outcome' as const, result: { applied: true } }] } };
  assert.equal(collectRunEvidence(acknowledged, draft, [], changedDoc).blocked, true,
    'a durable outcome also cannot authorize replay of an unmarked live commit');
  assert.equal(collectRunEvidence(metadata, draft, savedResult, doc).blocked, false,
    'manual draft actions remain replayable while the original live baseline is unchanged');
  const landed = { ...localTool, toolCallId: 'call-0', landed: true, landedRevision: revisionOf(changedDoc) };
  const afterLanding = { ...draft, tools: [landed, localTool] };
  assert.equal(collectRunEvidence(metadata, afterLanding, savedResult, changedDoc).blocked, false,
    'unlanded actions after the last verified landing use that landing as their baseline');
  assert.equal(collectRunEvidence(metadata, { ...afterLanding, tools: [{ ...landed, landedRevision: 'older-revision' }, localTool] },
    savedResult, changedDoc).blocked, true, 'the latest landing revision must still match the live project');
  assert.equal(collectRunEvidence(metadata, { ...draft, tools: [localTool, landed] }, savedResult, changedDoc).blocked, true,
    'an unmarked edit before a later landing may already be included in that landing');
  const freezeMessages: DisplayMessage[] = [];
  const turn = { state: { ctxRef: { current: { getDoc: () => changedDoc } },
    setMessages: (update: (messages: DisplayMessage[]) => DisplayMessage[]) => { freezeMessages.push(...update([])); },
    abortRef: { current: null }, runningRef: { current: true }, setRunning: () => undefined },
    get draft() { return assert.fail('restore must not replay an ambiguous landed edit'); } };
  assert.equal(restoreToolActions(turn as never, { runId } as never, [localTool], doc,
    { current: { seenToolCalls: new Set() } } as never, projectId,
    new Map([['call-1', { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'outcome', result: { applied: true } }]])), false);
  assert(freezeMessages.some((message) => message.reconcile), 'draft restoration shares the same landing safety gate');

  const legacyTurn = { state: { ctxRef: { current: { getDoc: () => changedDoc } } } };
  assert.equal(restoreToolActions(legacyTurn as never, { runId } as never,
    [{ ...localTool, landed: true }], doc,
    { current: { seenToolCalls: new Set() } } as never, projectId), true,
  'runs without durable recovery metadata retain their established landing behavior');


  const frozen = setup();
  await continueActiveRecovery(frozen.context(), frozen.prepared());
  assert.equal(frozen.calls.executorStarts, 0);
  assert.equal(frozen.calls.subscriptions, 0, 'a frozen coordinator must return before subscribing');
  assert.equal(frozen.state.refs.frozenRun.current, runId);
  assert(frozen.messages.some((message) => message.reconcile));
  assert(readStoredServerRun(projectId), 'freezing retains credentials');
  await recheckFrozenServerRun(projectId, frozen.state);
  assert.equal(frozen.calls.recovered, 1, 'recheck enters the handshake coordinator');

  const saved = setup();
  saveStoredServerRun(projectId, { ...readStoredServerRun(projectId)!, admissionPending: true, attempts: [{
    toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', status: 'result', result: { applied: true },
  }] });
  browserReady = () => saved.calls.executorStarts === 1;
  await continueActiveRecovery(saved.context(), saved.prepared());
  assert(requests.findIndex((url) => url.endsWith('/tool-result')) < requests.findIndex((url) => url.endsWith('/start')));
  assert.equal(saved.calls.executorStarts, 1);
  assert.equal(saved.calls.subscriptions, 1);
  assert.equal(readStoredServerRun(projectId)?.attempts?.length, 0);

  const failedDraft = setup();
  failedDraft.state.refs.options.current = { enabled: true, onRunStart: async () => { throw new Error('draft unavailable'); } };
  await assert.rejects(() => continueActiveRecovery(failedDraft.context(), failedDraft.prepared()), /draft unavailable/);
  assert(!requests.some((url) => url.endsWith('/start')), 'draft preparation failure cannot start the model');

  const live = setup();
  metadata = { status: 'running', firstEventId: 1, lastEventId: 2,
    recovery: { state: 'active', revision: 8, tools: [] } };
  await openSubscription(projectId, runId, 'capability', 0, live.state, live.stream);
  assert.equal(live.calls.attaches, 1, 'a running executor attaches SSE directly');
  assert.equal(live.calls.recovered, 0);
  assert.equal(live.calls.executorStops, 0, 'active reconnection retains any browser tool already in flight');
  metadata = { ...metadata, recovery: { state: 'ready', revision: 8, tools: [] } };
  await openSubscription(projectId, runId, 'capability', 0, live.state, live.stream);
  assert.equal(live.calls.recovered, 1, 'ownerless reconnect goes through recovery, not subscribe recursion');

  const source = Object.assign(new EventTarget(), { onopen: null, close: () => undefined });
  bindEventSource(projectId, runId, live.state, live.stream, source);
  source.dispatchEvent(new MessageEvent('recovery-blocked', { lastEventId: '3', data: '{}' }));
  assert.equal(live.calls.recovered, 2, 'an online freeze enters the coordinator immediately');

  const paused = setup();
  metadata = { status: 'paused', firstEventId: 1, lastEventId: 2,
    recovery: { state: 'paused', revision: 8, attemptNumber: 1, lastError: 'provider disconnected', tools: [] } };
  await continueActiveRecovery(paused.context(), paused.prepared());
  assert.equal(paused.calls.executorStarts, 0, 'refresh restores a paused draft without starting the executor');
  assert.equal(paused.calls.subscriptions, 0, 'paused hydration does not reconnect an executing model');
  assert(!requests.some((url) => url.endsWith('/start')), 'refresh never automatically starts a paused attempt');
  assert.equal(paused.state.refs.running.current, false, 'a paused run accepts the next user instruction');
  assert.equal(readStoredServerRun(projectId)?.paused, true);
  assert(paused.messages.some((message) => message.paused && /发送消息继续/.test(message.text)));
  const pauseSource = Object.assign(new EventTarget(), { onopen: null, close: () => undefined });
  bindEventSource(projectId, runId, paused.state, paused.stream, pauseSource);
  pauseSource.dispatchEvent(new MessageEvent('run-paused', { lastEventId: '3', data: JSON.stringify({ error: 'retryable error', attemptNumber: 1 }) }));
  assert.equal(readStoredServerRun(projectId)?.cursor, 3, 'pause atomically retains the stream watermark');
  assert.equal(readStoredServerRun(projectId)?.capability, 'capability');
  assert.equal(paused.state.refs.runId.current, runId);

  const baseline = setup();
  metadata = { status: 'completed', firstEventId: 10, lastEventId: 20,
    recovery: { state: 'finalized', revision: 9, replayBase: { firstEventId: 10, lastEventId: 20,
      revision: 9, resetsCursor: true, terminalText: 'authoritative complete text' } } };
  adoptServerRunBaseline(projectId, baseline.state, metadata, 2);
  assert.equal(baseline.state.refs.assistantText.current, 'authoritative complete text');
  assert.equal(baseline.state.refs.assistantThinking.current, '');
  assert.equal(readStoredServerRun(projectId)?.cursor, 20);
  assert.equal(readStoredServerRun(projectId)?.assistantText, 'authoritative complete text');
  assert.equal(baseline.messages.at(-1)?.text, 'authoritative complete text');
  metadata = { ...metadata, recovery: { ...metadata.recovery!, replayBase: { ...metadata.recovery!.replayBase!, terminalText: null } } };
  adoptServerRunBaseline(projectId, baseline.state, metadata, 2);
  assert.equal(baseline.state.refs.assistantText.current, '', 'unreconstructable deltas do not become a completed answer');

  const settled = setup();
  const continuation = { id: 'accepted-followup', text: '英文字幕', message: '英文字幕', previousAssistantText: 'partial' };
  saveStoredServerRun(projectId, { ...readStoredServerRun(projectId)!, content: 'edit\n\n英文字幕',
    continuationTurns: [continuation], pendingContinuation: continuation, assistantText: 'truncated final' });
  let committed = false;
  let rejectCommit = true;
  settled.state.refs.options.current = { enabled: true,
    onRunAbandon: async () => { assert(committed, 'final history commits before draft cleanup'); },
    session: { commitModelTurn: async (id: string, _length: number, content: string, text: string) => {
      assert.equal(id, runId); assert.equal(content, 'edit\n\n英文字幕');
      assert.equal(text, 'authoritative complete text', 'never commit the truncated browser reply');
      if (rejectCommit) throw new Error('chat save interrupted');
      committed = true;
    } } as never };
  metadata = { status: 'completed', firstEventId: 1, lastEventId: 20,
    recovery: { state: 'finalized', revision: 9, lastContinuationId: continuation.id,
      replayBase: { firstEventId: 1, lastEventId: 20, revision: 9, resetsCursor: true,
        terminalText: 'authoritative complete text' } } };
  await assert.rejects(() => finishLocalTerminal(settled.context(), metadata), /chat save interrupted/);
  assert(readStoredServerRun(projectId), 'failed history commit retains the continuation and capability');
  rejectCommit = false;
  await finishLocalTerminal(settled.context(), metadata);
  assert.equal(committed, true);
  assert.equal(readStoredServerRun(projectId), null);

  const unverifiable = setup();
  saveStoredServerRun(projectId, { ...readStoredServerRun(projectId)!, continuationTurns: [continuation] });
  metadata = { ...metadata, recovery: { ...metadata.recovery!, replayBase: { ...metadata.recovery!.replayBase!, terminalText: null } } };
  await finishLocalTerminal(unverifiable.context(), metadata);
  assert(readStoredServerRun(projectId), 'missing complete terminal text preserves evidence instead of clearing history');
  assert(unverifiable.messages.some((message) => message.reconcile));

  const ending = setup();
  ending.state.refs.frozenRun.current = runId;
  settlementFails = true;
  await endFrozenServerRun(projectId, ending.state);
  assert(readStoredServerRun(projectId), 'failed settlement retains the capability and attempts');
  assert.equal(ending.state.refs.running.current, true);
  settlementFails = false;
  await endFrozenServerRun(projectId, ending.state);
  assert.equal(readStoredServerRun(projectId), null);
  assert.equal(ending.state.refs.running.current, false, 'ending clears the send guard');
  assert.equal(ending.state.refs.runId.current, null);
  assert.equal(ending.state.refs.frozenRun.current, null);
  assert.equal(ending.state.refs.runExecutor.current, null);

  globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 });
  await assert.rejects(() => reconcileRunEvidence(projectId, runId, 'capability', doc), /HTTP 503/,
    'unavailable evidence must never be interpreted as no previous execution');
} finally {
  globalThis.fetch = originalFetch;
  configureSharedKvBackend(undefined);
}
console.log('serverRunRecoveryLifecycle.verify: live SSE, coordinated reconnect, stored outcomes, freeze/end and text baseline passed');
