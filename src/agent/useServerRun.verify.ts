import assert from 'node:assert/strict';
import type { AgentReference } from './context.ts';
import {
  buildServerRunPayload,
  loadServerRunMetadata,
  recoveredServerRunTerminal,
  requestServerRunCancellation,
  requestServerRunStart,
  SERVER_RUN_CAPABILITY_HEADER,
  serverRunShouldResume,
} from './serverRunProtocol.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import {
  isPermanentServerRunRecoveryError,
  permanentServerRunRecoveryError,
  recoveredRunAwaitsProposal,
  serverRunRecoveryDelay,
  shouldRetryPendingServerRunAdmission,
  storedServerRunPreservesHydration,
  appendStreamingThinking,
  restoredRunMessages,
} from './serverRunRecovery.ts';
import { prepareServerRunTransport } from './serverRunSend.ts';


const transportRefs = {
  abort: { current: null as AbortController | null },
  assistantText: { current: 'previous response' },
  assistantThinking: { current: 'previous thinking' },
  cursor: { current: 37 },
  staleRecoveryRun: { current: 'stale-run' as string | null },
  terminalRun: { current: 'previous-run' as string | null },
};
const transportAbort = new AbortController();
prepareServerRunTransport(transportRefs, transportAbort);
assert.equal(transportRefs.abort.current, transportAbort);
assert.equal(transportRefs.assistantText.current, '');
assert.equal(transportRefs.assistantThinking.current, '');
assert.equal(transportRefs.cursor.current, 0,
  'each new server run starts at cursor zero instead of inheriting the prior run cursor');
assert.equal(transportRefs.staleRecoveryRun.current, null);
assert.equal(transportRefs.terminalRun.current, null);

const references: AgentReference[] = [{
  id: 'asset-1',
  name: 'Interview',
  kind: 'video',
}];
const sessionId = 'external-session-stable-1';
const askPayload = buildServerRunPayload(
  'project-1',
  '  What is selected?  ',
  { askOnly: true, references },
  { externalSessionId: sessionId, cacheMode: 'short', maxOutputTokens: 4_096 },
);

assert.equal(askPayload.projectId, 'project-1');
assert.match(askPayload.runId, /^[0-9a-f-]{36}$/i);
assert.match(askPayload.capability, /^[A-Za-z0-9_-]{43}$/);
assert.deepEqual(askPayload.messages, [{ role: 'user', content: 'What is selected?' }]);
assert.equal(askPayload.askOnly, true, 'ask-only mode survives the server-run transport boundary');
assert.deepEqual(askPayload.references, references, 'message references survive the server-run transport boundary');
assert.notEqual(askPayload.references, references, 'payload snapshots references instead of retaining caller mutation');
assert.equal(askPayload.externalSessionId, sessionId, 'retries and reconnects retain the external session identity');
assert.equal(askPayload.autonomousAcceptance, false, 'old callers retain the previous completion behavior');
assert.equal(askPayload.maxAcceptanceIterations, 3);

const editPayload = buildServerRunPayload(
  'project-1',
  'Trim the clip',
  {},
  { externalSessionId: sessionId, cacheMode: 'short', maxOutputTokens: 4_096 },
);
assert.equal(editPayload.askOnly, false);
assert.notEqual(editPayload.runId, askPayload.runId, 'each create attempt has a stable unique identity');
assert.notEqual(editPayload.capability, askPayload.capability);
assert.deepEqual(editPayload.references, []);
assert.equal(editPayload.externalSessionId, sessionId);
assert(
  editPayload.tools.length < TOOL_SCHEMAS.length,
  'server transport preserves request-scoped tool activation instead of sending the full catalog',
);
assert(
  editPayload.tools.some((schema) => schema.name === 'edit_item'),
  'edit intent exposes its routed edit tool group',
);
assert.notDeepEqual(
  askPayload.tools,
  editPayload.tools,
  'ask-only transport uses the existing read-only tool contract',
);

const contextualPayload = buildServerRunPayload(
  'project-1',
  'Continue',
  {},
  {
    history: [
      { role: 'assistant', content: 'orphaned preface' },
      { role: 'user', content: 'Earlier request' },
      { role: 'assistant', content: 'Earlier answer' },
    ],
    systemPrompt: 'Canonical project context',
    provider: 'deepseek',
    model: 'deepseek-chat',
    cacheMode: 'long',
    autonomousAcceptance: true,
    maxAcceptanceIterations: 5,
    maxOutputTokens: 64_000,
    openAiApiMode: 'chat',
    externalSessionId: sessionId,
  },
);
assert.deepEqual(contextualPayload.messages, [
  { role: 'user', content: 'Earlier request' },
  { role: 'assistant', content: 'Earlier answer' },
  { role: 'user', content: 'Continue' },
]);
assert.equal(contextualPayload.systemPrompt, 'Canonical project context');
assert.equal(contextualPayload.provider, 'deepseek');
assert.equal(contextualPayload.model, 'deepseek-chat');
assert.equal(contextualPayload.openAiApiMode, 'chat');
assert.equal(contextualPayload.cacheMode, 'long');
assert.equal(contextualPayload.autonomousAcceptance, true);
assert.equal(contextualPayload.maxAcceptanceIterations, 5);
assert.equal(
  contextualPayload.maxOutputTokens,
  64_000,
  'the effective model output budget is not collapsed to the legacy 4096-token cap',
);
const boundedPayload = buildServerRunPayload(
  'project-1',
  'Continue after a long conversation',
  {},
  {
    history: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `${index}:` + 'x'.repeat(31_998),
    })),
    cacheMode: 'short',
    maxOutputTokens: 4_096,
  },
);
const boundedPayloadBytes = new TextEncoder()
  .encode(JSON.stringify(boundedPayload)).byteLength;
assert(
  boundedPayloadBytes < 1024 * 1024,
  'the complete server-run request stays below the 1 MiB admission envelope',
);
assert(boundedPayload.messages.length <= 64, 'history plus the current input respects the message cap');
assert.equal(boundedPayload.messages.at(-1)?.content, 'Continue after a long conversation');
const multibytePayload = buildServerRunPayload(
  'project-1',
  '续'.repeat(32_000),
  {},
  {
    history: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: '历'.repeat(32_000),
    })),
    systemPrompt: '系'.repeat(160_000),
    cacheMode: 'short',
    maxOutputTokens: 4_096,
  },
);
const multibytePayloadBytes = new TextEncoder()
  .encode(JSON.stringify(multibytePayload)).byteLength;
assert(multibytePayload.messages.length > 1, 'recent multibyte history is retained when space remains');
assert(
  multibytePayloadBytes < 1024 * 1024,
  'multibyte system prompt, history, and input are bounded by actual UTF-8 request bytes',
);

assert.equal(serverRunShouldResume(true, 'project-1', 'project-1'), true);
assert.equal(
  serverRunShouldResume(false, 'project-1', 'project-1'),
  false,
  'default-off mode never reconnects a hidden server run',
);
assert.equal(
  serverRunShouldResume(true, 'project-old', 'project-1'),
  false,
  'a stored run from another project is not resumed',
);
assert.equal(serverRunShouldResume(true, undefined, 'project-1'), false);
assert.equal(
  recoveredServerRunTerminal({ status: 'completed', lastEventId: 9 }, 8),
  null,
  'reload replays an unconsumed durable terminal event before finalizing',
);
assert.equal(
  recoveredServerRunTerminal({ status: 'completed', lastEventId: 9 }, 9),
  'completed',
  'reload finalizes when the stored cursor proves the durable terminal event was consumed',
);
assert.equal(
  recoveredServerRunTerminal({ status: 'running', lastEventId: 9 }, 9),
  null,
);
assert.equal(
  recoveredServerRunTerminal({ status: 'awaiting-user', lastEventId: 9 }, 9),
  'awaiting_user',
  'a completed server turn can hand control back to the user without becoming a failure',
);
assert.equal(
  recoveredRunAwaitsProposal({ status: 'waiting_approval', proposalIds: ['proposal-1'] }),
  true,
);
assert.equal(
  recoveredRunAwaitsProposal({ status: 'waiting_approval', proposalIds: [] }),
  false,
  'a tool guard approval is recovered instead of being mistaken for a proposal',
);
assert.equal(serverRunRecoveryDelay(0), 500);
assert.equal(serverRunRecoveryDelay(20), 30_000,
  'detached transport recovery remains long-lived with a bounded delay');
assert.equal(
  isPermanentServerRunRecoveryError(new Error('server run metadata failed: HTTP 404')),
  true,
);
assert.equal(
  isPermanentServerRunRecoveryError(new Error('server run metadata failed: HTTP 403')),
  true,
  'an invalid persisted capability is stale rather than transient',
);
assert.equal(
  isPermanentServerRunRecoveryError({ status: 410 }),
  true,
);
assert.equal(
  isPermanentServerRunRecoveryError(new Error('Agent session generation changed.')),
  true,
);
assert.equal(
  isPermanentServerRunRecoveryError(
    permanentServerRunRecoveryError('Stored server run has an invalid active tool set.'),
  ),
  true,
);
assert.equal(
  isPermanentServerRunRecoveryError(new Error('server run metadata failed: HTTP 503')),
  false,
  'only transient recovery failures retain reconnect backoff',
);
const pendingAdmission = {
  projectId: 'project-1',
  runId: askPayload.runId,
  capability: askPayload.capability,
  createdAt: 1_000,
  admissionPending: true,
};
assert.equal(
  storedServerRunPreservesHydration(pendingAdmission),
  true,
  'hydration preserves a run whose create response may have been lost before lease acquisition',
);
assert.equal(
  storedServerRunPreservesHydration({
    ...pendingAdmission,
    admissionPending: false,
    leaseToken: 'lease-after-admission',
  }),
  true,
);
assert.equal(
  storedServerRunPreservesHydration({ ...pendingAdmission, capability: undefined }),
  false,
  'a recovery record without bearer authority cannot preserve an active run',
);
const missingAdmission = new Error('server run metadata failed: HTTP 404');
assert.equal(
  shouldRetryPendingServerRunAdmission(pendingAdmission, missingAdmission, 30_999),
  true,
  'a reload cannot abandon a create request while its POST may still be reaching admission',
);
assert.equal(
  shouldRetryPendingServerRunAdmission(pendingAdmission, missingAdmission, 31_001),
  false,
  'an unadmitted create becomes stale after the bounded admission race window',
);
assert.equal(
  shouldRetryPendingServerRunAdmission(
    { ...pendingAdmission, admissionPending: false },
    missingAdmission,
    1_001,
  ),
  false,
);
assert.equal(
  shouldRetryPendingServerRunAdmission(
    pendingAdmission,
    new Error('server run metadata failed: HTTP 403'),
    1_001,
  ),
  false,
  'invalid capabilities remain fail-closed during the admission grace window',
);


const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; method: string; capability: string | null }> = [];
globalThis.fetch = async (input, init) => {
  requests.push({
    url: String(input),
    method: init?.method ?? 'GET',
    capability: new Headers(init?.headers).get(SERVER_RUN_CAPABILITY_HEADER),
  });
  if (String(input).endsWith('/start')) {
    return new Response(JSON.stringify({ outcome: 'started' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (String(input).endsWith('/cancel')) {
    return new Response(JSON.stringify({ status: 'completed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({
    status: 'completed',
    firstEventId: 7,
    lastEventId: 9,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
assert.deepEqual(
  await loadServerRunMetadata('project-1', 'run-1', 'capability-1'),
  { status: 'completed', firstEventId: 7, lastEventId: 9 },
);
await requestServerRunStart('project-1', 'run-1', 'capability-1');
assert.equal(
  await requestServerRunCancellation('project-1', 'run-1', 'capability-1'),
  'completed',
  'late cancellation preserves the authoritative completed status',
);
assert.deepEqual(requests, [
  { url: '/api/agent-runs/run-1?projectId=project-1', method: 'GET', capability: 'capability-1' },
  { url: '/api/agent-runs/run-1/start', method: 'POST', capability: 'capability-1' },
  { url: '/api/agent-runs/run-1/cancel', method: 'POST', capability: 'capability-1' },
]);
globalThis.fetch = async () => new Response(null, { status: 503 });
await assert.rejects(
  requestServerRunCancellation('project-1', 'run-1', 'capability-1'),
  /HTTP 503/,
  'the browser does not locally finalize a cancellation the server rejected',
);
globalThis.fetch = originalFetch;

// thinking stream accumulates onto the streaming assistant message…
const thinkingStream = appendStreamingThinking([{ role: 'user', text: 'edit' }], 'plan');
assert.deepEqual(
  thinkingStream,
  [{ role: 'user', text: 'edit' }, { role: 'assistant', text: '', thinking: 'plan' }],
  'a thinking delta before any text opens an assistant message with thinking',
);
assert.deepEqual(
  appendStreamingThinking(thinkingStream, ' more'),
  [
    { role: 'user', text: 'edit' },
    { role: 'assistant', text: '', thinking: 'plan more' },
  ],
  'later thinking deltas append to the same message',
);
// …and restored runs carry thinking back into the rebuilt assistant message.
assert.deepEqual(
  restoredRunMessages(
    [{ role: 'user', text: 'edit' }],
    'edit',
    'done',
    'plan more',
  ),
  [
    { role: 'user', text: 'edit' },
    { role: 'assistant', text: 'done', thinking: 'plan more' },
  ],
  'restored run messages preserve stored thinking',
);
assert.deepEqual(
  restoredRunMessages([{ role: 'user', text: 'edit' }], 'edit', 'done'),
  [
    { role: 'user', text: 'edit' },
    { role: 'assistant', text: 'done' },
  ],
  'runs without thinking keep the previous message shape',
);

console.log('server run browser adapter verification passed');
