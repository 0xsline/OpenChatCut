import assert from 'node:assert/strict';
import type { LLMMessage } from './runtime';
import { INITIAL } from '../editor/initial';
import type { Proposal } from './proposal';
import type { DisplayMessage } from './agent-session';
import { clearAgentHistory } from './useAgentHistoryActions';
import type { AgentHookState } from './useAgentState';
import {
  createAgentRun,
  loadAgentRuntimeSidecar,
  agentArtifactKey,
  purgeAgentRuntime,
  resetAgentRuntimeStoreMemory,
  loadAgentArtifact,
  sha256Text,
  subscribeAgentRuntime,
  type AgentRunStatus,
  storeAgentArtifact,
} from '../persist/agentRuntimeStore';
import {
  clearChat,
  docFromTimeline,
  loadChat,
  resetProjectStoreMemory,
  saveChat,
} from '../persist/projectStore';
import { kvDel, kvGet, kvSet } from '../persist/sharedKv';
import { loadProposal, saveProposal } from '../persist/proposalStore';
import {
  agentSessionWriteGeneration,
  currentAgentSessionGeneration,
} from '../persist/agentSessionGeneration';

interface FakeAgentState {
  state: AgentHookState;
  messages: DisplayMessage[];
  contextCleared: boolean;
}

function fakeAgentState(text: string): FakeAgentState {
  const fake: FakeAgentState = {
    state: null as unknown as AgentHookState,
    messages: [{ role: 'user', text }],
    contextCleared: false,
  };
  const llm: LLMMessage[] = [{ role: 'user', content: text }];
  fake.state = {
    runningRef: { current: false },
    proposalRef: { current: null },
    hydratedRef: { current: true },
    hydrationEpochRef: { current: 0 },
    llmRef: { current: llm },
    llmProviderRef: { current: 'deepseek' },
    toolFailuresRef: { current: { clear: () => undefined } },
    setProposal: () => undefined,
    setProposalStale: () => undefined,
    setChangeLog: () => undefined,
    setHydrated: () => undefined,
    setMessages: (next: Parameters<AgentHookState['setMessages']>[0]) => {
      fake.messages = typeof next === 'function' ? next(fake.messages) : next;
    },
    replaceContextUsage: (next: Parameters<AgentHookState['replaceContextUsage']>[0]) => {
      fake.contextCleared = next === null;
    },
  } as unknown as AgentHookState;
  return fake;
}

async function seedRun(projectId: string, status: AgentRunStatus, input: string): Promise<string> {
  const now = Date.now();
  const runId = crypto.randomUUID();
  await createAgentRun({
    version: 1,
    runId,
    projectId,
    status,
    askOnly: false,
    userInputPreview: input,
    userInputDigest: await sha256Text(input),
    createdAt: now,
    updatedAt: now,
    artifactIds: [],
    checkpointIds: [],
    proposalIds: [],
    events: [],
  });
  return runId;
}

async function seedChat(projectId: string, text: string): Promise<void> {
  await saveChat(projectId, {
    messages: [{ role: 'user', text }],
    llm: [{ role: 'user', content: text }],
    changeLog: [{ id: 'keep-rollback-history' }],
    llmFormat: 'ai-sdk-v1',
    llmProvider: 'deepseek',
  });
}

resetProjectStoreMemory();
resetAgentRuntimeStoreMemory();

const projectId = `clear-history-${crypto.randomUUID()}`;
await seedChat(projectId, 'sensitive context');
const staleChat = await loadChat(projectId);
const runId = await seedRun(projectId, 'completed', 'sensitive context');
const artifactBody = 'sensitive tool output';
const artifactId = 'clear-history-art';
await storeAgentArtifact({
  version: 1,
  artifactId,
  projectId,
  runId,
  kind: 'tool-result',
  bodySha256: await sha256Text(artifactBody),
  originalBytes: new TextEncoder().encode(artifactBody).byteLength,
  originalChars: artifactBody.length,
  createdAt: Date.now(),
  redacted: false,
  binaryOmitted: false,
  body: artifactBody,
});
const staleRuntime = await loadAgentRuntimeSidecar(projectId);
const proposal: Proposal = {
  id: 'clear-history-proposal',
  title: 'Clear this proposal',
  options: [{
    id: 'clear-history-option',
    label: 'No-op',
    recommended: true,
    summary: 'No project edit.',
    totalImpact: 'No project edit.',
    operations: [{
      tool: 'verify_clear',
      args: {},
      actions: [],
      action: 'verify',
      target: 'Agent context',
      impact: 'No project edit.',
    }],
  }],
  summary: 'Must not survive context clearing.',
  totalImpact: 'No project edit.',
  baseDoc: docFromTimeline(INITIAL),
  resultState: INITIAL,
};
await saveProposal(projectId, proposal);
let runtimeNotifications = 0;
const unsubscribe = subscribeAgentRuntime(projectId, () => { runtimeNotifications += 1; });
const cleared = fakeAgentState('sensitive context');
await clearAgentHistory(cleared.state, projectId);
unsubscribe();

assert.deepEqual(cleared.messages, [], 'rendered chat clears');
assert.deepEqual(cleared.state.llmRef.current, [], 'provider context clears');
assert.equal(cleared.contextCleared, true, 'context usage meter clears');
assert.equal(await loadChat(projectId), null, 'durable provider/chat context clears');
assert.equal((await loadAgentRuntimeSidecar(projectId)).runs.length, 0, 'inspector run history clears');
assert.equal(runtimeNotifications, 1, 'open inspectors refresh after clearing');
assert.equal(await loadProposal(projectId), null, 'durable proposal clears');
assert.equal(await loadAgentArtifact(projectId, artifactId), null, 'artifact lookup clears');
assert.equal(await kvGet(agentArtifactKey(projectId, artifactId)), undefined, 'artifact bytes are reclaimed');
assert.equal(await kvGet(`chat:${projectId}`), undefined, 'chat bytes are reclaimed');
assert.equal(await kvGet(`proposal:${projectId}`), undefined, 'proposal bytes are reclaimed');
assert.equal(await kvGet(`agent-runtime:${projectId}`), undefined, 'runtime bytes are reclaimed');
assert.ok(staleChat, 'stale chat fixture captured');
await kvSet(`chat:${projectId}`, staleChat);
await kvSet(`agent-runtime:${projectId}`, staleRuntime);
assert.equal(await loadChat(projectId), null, 'late old-generation chat cannot resurrect');
assert.equal((await loadAgentRuntimeSidecar(projectId)).runs.length, 0, 'late old-generation runtime cannot resurrect');

await seedChat(projectId, 'must survive active run');
await seedRun(projectId, 'running', 'external active run');
await kvSet(`chat:${projectId}`, staleChat);
await kvSet(`agent-runtime:${projectId}`, staleRuntime);
assert.deepEqual(
  (await loadChat(projectId))?.messages,
  [{ role: 'user', text: 'must survive active run' }],
  'late old-generation chat cannot overwrite the new session',
);
assert.equal(
  (await loadAgentRuntimeSidecar(projectId)).runs[0]?.status,
  'running',
  'late old-generation runtime cannot overwrite the new session',
);
const blocked = fakeAgentState('must survive active run');
await clearAgentHistory(blocked.state, projectId);
assert.notEqual(await loadChat(projectId), null, 'active run blocks chat deletion');
assert.equal((await loadAgentRuntimeSidecar(projectId)).runs.length, 1, 'active run ledger survives');
assert.deepEqual(blocked.state.llmRef.current, [{ role: 'user', content: 'must survive active run' }]);
assert.match(blocked.messages.at(-1)?.text ?? '', /无法清空/);
await purgeAgentRuntime(projectId);
await clearChat(projectId);

const ownRunId = await seedRun(projectId, 'waiting_approval', 'current proposal run');
await seedChat(projectId, 'current proposal context');
const ownProposal = {
  ...proposal,
  id: 'current-proposal',
  agentRunId: ownRunId,
};
await saveProposal(projectId, ownProposal);
const ownGeneration = await currentAgentSessionGeneration(projectId);
const own = fakeAgentState('current proposal context');
assert.equal(own.state.proposalRef.current, null, 'durable proposal is not pre-hydrated');
await clearAgentHistory(own.state, projectId);
assert.equal(await loadChat(projectId), null, 'current proposal chat clears');
assert.equal(await loadProposal(projectId), null, 'current proposal record clears');
assert.equal((await loadAgentRuntimeSidecar(projectId)).runs.length, 0, 'current proposal run clears');
assert.equal(
  await kvGet(`agent-session-chat:${projectId}:${ownGeneration}`),
  undefined,
  'generation-scoped chat bytes are reclaimed',
);
assert.equal(
  await kvGet(`agent-session-runtime:${projectId}:${ownGeneration}`),
  undefined,
  'generation-scoped runtime bytes are reclaimed',
);
const refreshedGeneration = await currentAgentSessionGeneration(projectId);
assert.notEqual(refreshedGeneration, ownGeneration, 'clear publishes a new authoritative generation');
assert.equal(
  await agentSessionWriteGeneration(projectId),
  refreshedGeneration,
  'a client that observes the cutover writes future turns into the new generation',
);

await purgeAgentRuntime(projectId);
await clearChat(projectId);
const corruptProjectId = `clear-history-corrupt-${crypto.randomUUID()}`;
await kvSet(`agent-session-generation:${corruptProjectId}`, {
  version: 2,
  generation: 'future',
  clearedAt: Date.now(),
});
assert.equal(await loadChat(corruptProjectId), null, 'corrupt generation fails closed for chat');
await assert.rejects(
  () => loadAgentRuntimeSidecar(corruptProjectId),
  /Stored Agent session generation is invalid/,
);
await kvDel(`agent-session-generation:${corruptProjectId}`);

console.log('useAgentHistoryActions.verify: context and inspector history clear atomically');
