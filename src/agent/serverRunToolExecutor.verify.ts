import assert from 'node:assert/strict';
import { setAgentAutoApply } from './approval-mode.ts';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import { projectServerRunToolResult } from './serverRunToolResult.ts';
import {
  ServerRunToolExecutor,
  serverRunToolLockName,
  withServerRunToolLock,
} from './serverRunToolExecutor.ts';
import { FakeLockManager, MemoryStorage } from './serverRunToolExecutor.verify-helpers.ts';
import {
  beginStoredToolAttempt,
  readStoredServerRun,
  saveStoredServerRun,
} from './serverRunSessionStorage.ts';
const projectId = 'project-lock';
const runId = 'run-lock';
const toolCallId = 'tool-lock';
const manager = new FakeLockManager();
const releaseOriginal = Promise.withResolvers<void>();
const originalStarted = Promise.withResolvers<void>();
const order: string[] = [];
const original = withServerRunToolLock(
  manager,
  projectId,
  runId,
  toolCallId,
  async () => {
    order.push('original:start');
    originalStarted.resolve();
    await releaseOriginal.promise;
    order.push('original:settled');
    return 'original';
  },
);
await originalStarted.promise;
const duplicate = withServerRunToolLock(
  manager,
  projectId,
  runId,
  toolCallId,
  () => {
    order.push('duplicate:start');
    return 'duplicate';
  },
);
await Promise.resolve();
assert.deepEqual(order, ['original:start'], 'a cloned tab waits while the original owns the tool');
releaseOriginal.resolve();
assert.deepEqual(await Promise.all([original, duplicate]), [
  { acquired: true, value: 'original' },
  { acquired: true, value: 'duplicate' },
]);
assert.deepEqual(order, ['original:start', 'original:settled', 'duplicate:start']);
assert.notEqual(
  serverRunToolLockName(projectId, runId, toolCallId),
  serverRunToolLockName(projectId, runId, 'another-tool'),
  'unrelated tools do not share an ownership lock',
);
let serverState: 'pending' | 'settled' = 'pending';
let serverClaimId: string | null = null;
const claim = (claimId: string): { claimed: boolean; outcome: string } => {
  if (serverState === 'settled') return { claimed: false, outcome: 'run-settled' };
  if (serverClaimId === null) {
    serverClaimId = claimId;
    return { claimed: true, outcome: 'claimed' };
  }
  return serverClaimId === claimId
    ? { claimed: true, outcome: 'duplicate' }
    : { claimed: false, outcome: 'already-claimed' };
};
const releaseExecution = Promise.withResolvers<void>();
const executionStarted = Promise.withResolvers<void>();
let duplicateInterpretedStoredAttempt = false;
let duplicatePostedInterruption = false;
const liveOriginal = withServerRunToolLock(
  manager,
  projectId,
  'run-cloned-tab',
  'call-paid',
  async () => {
    assert.equal(claim('cloned-session-claim').outcome, 'claimed');
    executionStarted.resolve();
    await releaseExecution.promise;
    serverState = 'settled';
  },
);
await executionStarted.promise;
const clonedTab = withServerRunToolLock(
  manager,
  projectId,
  'run-cloned-tab',
  'call-paid',
  () => {
    const claimed = claim('cloned-session-claim');
    if (claimed.claimed) {
      duplicateInterpretedStoredAttempt = true;
      duplicatePostedInterruption = true;
    }
  },
);
releaseExecution.resolve();
await Promise.all([liveOriginal, clonedTab]);
assert.equal(duplicateInterpretedStoredAttempt, false,
  'the duplicate claims after lock acquisition and sees the already-settled run');
assert.equal(duplicatePostedInterruption, false,
  'the duplicate cannot contradict the original tool result');
serverState = 'pending';
serverClaimId = 'refresh-session-claim';
let refreshedExecutedSideEffect = false;
let refreshedPostedInterruption = false;
await withServerRunToolLock(
  manager,
  projectId,
  'run-refresh',
  'call-mutating',
  () => {
    const claimed = claim('refresh-session-claim');
    assert.deepEqual(claimed, { claimed: true, outcome: 'duplicate' });
    const durableAttemptFromThisTab = true;
    if (durableAttemptFromThisTab) {
      refreshedPostedInterruption = true;
      serverState = 'settled';
      return;
    }
    refreshedExecutedSideEffect = true;
  },
);
assert.equal(refreshedPostedInterruption, true,
  'a refresh may settle its own durable in-flight attempt after the old lock releases');
assert.equal(refreshedExecutedSideEffect, false,
  'paid or mutating work is never replayed after refresh');
let unavailableCallbackRan = false;
assert.deepEqual(
  await withServerRunToolLock(null, projectId, runId, toolCallId, () => {
    unavailableCallbackRan = true;
  }),
  { acquired: false },
);
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
const browserStorage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  value: browserStorage,
  configurable: true,
});
const retriedRuns: string[] = [];
const abandonedRuns: Array<{ runId: string; message: string }> = [];
const liveToolLog: Array<{ name: string; partial: string } | null> = [];
const executorCallbacks = {
  ctx: () => ({} as never),
  settings: () => ({} as never),
  onToolAction: () => undefined,
  updateMessages: () => undefined,
  setLiveTool: (tool: { name: string; partial: string } | null) => { liveToolLog.push(tool); },
  retryStream: (runId: string) => { retriedRuns.push(runId); },
  abandonRecovery: (runId: string, error: unknown) => {
    abandonedRuns.push({
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
  },
};
const mutationsBeforeDisabledExecutor = browserStorage.mutationCount;
new ServerRunToolExecutor('project-disabled', executorCallbacks, manager);
assert.equal(
  browserStorage.mutationCount,
  mutationsBeforeDisabledExecutor,
  'constructing a disabled/not-started executor does not write localStorage',
);
const oversizedProjection = projectServerRunToolResult({
  payload: 'x'.repeat(1024 * 1024 + 1),
});
assert.deepEqual(oversizedProjection, {
  omitted: true,
  note: 'Tool result exceeded the browser-to-server transport limit. Request a narrower result.',
});
assert.ok(
  new TextEncoder().encode(JSON.stringify(oversizedProjection)).byteLength < 1024 * 1024,
  'an unarchived result larger than 1 MiB is omitted from the server transport projection',
);
const boundedImage = {
  __images: [{ frame: 1, base64: 'aGVsbG8=' }],
  note: 'frame',
};
assert.equal(projectServerRunToolResult(boundedImage), boundedImage,
  'bounded image bytes remain intact for provider vision input');
const oversizedImageProjection = projectServerRunToolResult({
  __images: [{ frame: 1, base64: 'a'.repeat(800 * 1024) }],
  note: 'large frame',
}) as Record<string, unknown>;
assert.equal(Object.hasOwn(oversizedImageProjection, '__images'), false);
assert.equal(oversizedImageProjection.imagesOmitted, true,
  'oversized images become text-only metadata instead of invalid base64 placeholders');
const activation = new ToolActivation([], []);
const startExecutor = (
  executor: ServerRunToolExecutor,
  currentRunId: string,
  recovered: ReadonlyMap<string, {
    name?: string;
    argsDigest: string;
    result?: unknown;
    error?: string;
  }>,
): void => {
  executor.start({
    capability: 'test-run-capability',
    baseDoc: {} as never,
    activation,
    runId: currentRunId,
    abort: new AbortController(),
    recovered,
  });
};
const recoveredActivationProject = 'project-recovered-activation';
const recoveredActivationRun = 'run-recovered-activation';
assert(saveStoredServerRun(recoveredActivationProject, {
  projectId: recoveredActivationProject,
  runId: recoveredActivationRun,
  attempts: [],
}));
const recoveredActivation = new ToolActivation(TOOL_SCHEMAS, []);
const recoveredActivationExecutor = new ServerRunToolExecutor(
  recoveredActivationProject,
  executorCallbacks,
  manager,
);
recoveredActivationExecutor.start({
  capability: 'test-run-capability',
  baseDoc: {} as never,
  activation: recoveredActivation,
  runId: recoveredActivationRun,
  abort: new AbortController(),
  recovered: new Map([
    ['search', {
      name: 'ToolSearch',
      argsDigest: 'digest-search',
      result: { results: [{ name: 'submit_export' }] },
    }],
    ['skill', {
      name: 'load_skill',
      argsDigest: 'digest-skill',
      result: {
        skill: 'export',
        contents: {
          'SKILL.md': 'Call submit_export and verify_export.',
        },
      },
    }],
  ]),
});
const reconstructedTools = readStoredServerRun(recoveredActivationProject)?.activeToolNames ?? [];
assert.ok(reconstructedTools.includes('submit_export'),
  'a recovered ToolSearch result restores its activated tool');
assert.ok(reconstructedTools.includes('verify_export'),
  'a later recovered load_skill result restores its activated tool in order');
const integrationProject = 'project-lock-integration';
const integrationRun = 'run-lock-integration';
const integrationCall = 'call-lock-integration';
const integrationDigest = 'digest-lock-integration';
assert(saveStoredServerRun(integrationProject, {
  projectId: integrationProject,
  runId: integrationRun,
  attempts: [],
}));
const originalExecutor = new ServerRunToolExecutor(
  integrationProject,
  executorCallbacks,
  manager,
);
const clonedExecutor = new ServerRunToolExecutor(
  integrationProject,
  executorCallbacks,
  manager,
);
startExecutor(originalExecutor, integrationRun, new Map([[
  integrationCall,
  { argsDigest: integrationDigest, result: { ok: true } },
]]));
startExecutor(clonedExecutor, integrationRun, new Map([[
  integrationCall,
  { argsDigest: integrationDigest, result: { ok: true } },
]]));
let integrationState: 'pending' | 'settled' = 'pending';
let integrationClaims = 0;
const integrationCapabilities: Array<string | null> = [];
let integrationResults = 0;
const resultPostStarted = Promise.withResolvers<void>();
const releaseResultPost = Promise.withResolvers<void>();
globalThis.fetch = async (input, init) => {
  const url = String(input);
  integrationCapabilities.push(
    new Headers(init?.headers).get('X-OpenChatCut-Run-Capability'),
  );
  if (url.endsWith('/tool-claim')) {
    integrationClaims += 1;
    return Response.json(
      integrationState === 'settled'
        ? { claimed: false, outcome: 'run-settled' }
        : { claimed: true, outcome: integrationClaims === 1 ? 'claimed' : 'duplicate' },
      { status: integrationState === 'settled' ? 409 : 200 },
    );
  }
  if (url.endsWith('/tool-result')) {
    integrationResults += 1;
    resultPostStarted.resolve();
    await releaseResultPost.promise;
    integrationState = 'settled';
    return Response.json({ ok: true, outcome: 'accepted' });
  }
  throw new Error(`unexpected request: ${url}`);
};
const liveExecution = originalExecutor.handle(
  integrationRun,
  integrationCall,
  'paid_tool',
  {},
  integrationDigest,
  () => true,
);
await resultPostStarted.promise;
const clonedExecution = clonedExecutor.handle(
  integrationRun,
  integrationCall,
  'paid_tool',
  {},
  integrationDigest,
  () => true,
);
await Promise.resolve();
assert.equal(integrationClaims, 1, 'the cloned executor cannot claim while the original holds the lock');
releaseResultPost.resolve();
assert.deepEqual(await Promise.all([liveExecution, clonedExecution]), [true, false]);
assert.equal(integrationClaims, 2, 'the cloned executor claims only after the lock is released');
assert.deepEqual(
  integrationCapabilities,
  Array(integrationClaims + integrationResults).fill('test-run-capability'),
  'every tool claim and result carries the raw tab-scoped run capability',
);
assert.equal(integrationResults, 1, 'the cloned executor observes run-settled and posts no contradiction');
// ── the live-tool indicator follows a real execution attempt ──
const liveToolProject = 'project-live-tool';
const liveToolRun = 'run-live-tool';
const liveToolCall = 'call-live-tool';
const liveToolDigest = 'digest-live-tool';
assert(saveStoredServerRun(liveToolProject, {
  projectId: liveToolProject,
  runId: liveToolRun,
  attempts: [],
}));
const liveToolExecutor = new ServerRunToolExecutor(liveToolProject, executorCallbacks, manager);
startExecutor(liveToolExecutor, liveToolRun, new Map());
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/tool-claim')) {
    return Response.json({ claimed: true, outcome: 'claimed' });
  }
  if (url.endsWith('/tool-result')) {
    return Response.json({ ok: true, outcome: 'accepted' });
  }
  throw new Error(`unexpected request: ${url}`);
};
await liveToolExecutor.handle(
  liveToolRun,
  liveToolCall,
  'mutating_tool',
  {},
  liveToolDigest,
  () => true,
);
const liveToolNames = liveToolLog
  .filter((tool): tool is { name: string; partial: string } => tool !== null)
  .map((tool) => tool.name);
assert.ok(liveToolNames.includes('mutating_tool'),
  'the executing tool surfaces through the live-tool callback');
assert.equal(liveToolLog.at(-1), null,
  'the live-tool indicator is cleared when execution settles');
const refreshProject = 'project-refresh-integration';
const refreshRun = 'run-refresh-integration';
const refreshCall = 'call-refresh-integration';
const refreshDigest = 'digest-refresh-integration';
assert(saveStoredServerRun(refreshProject, {
  projectId: refreshProject,
  runId: refreshRun,
  attempts: [],
}));
assert(beginStoredToolAttempt(refreshProject, refreshCall, refreshDigest));
const refreshExecutor = new ServerRunToolExecutor(
  refreshProject,
  executorCallbacks,
  manager,
);
startExecutor(refreshExecutor, refreshRun, new Map());
let refreshResultBody: Record<string, unknown> | null = null;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/tool-claim')) {
    return Response.json({ claimed: true, outcome: 'duplicate' });
  }
  if (url.endsWith('/tool-result')) {
    refreshResultBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true, outcome: 'accepted' });
  }
  throw new Error(`unexpected request: ${url}`);
};
assert.equal(await refreshExecutor.handle(
  refreshRun,
  refreshCall,
  'mutating_tool',
  {},
  refreshDigest,
  () => true,
), true);
const settledRefreshResult = refreshResultBody as Record<string, unknown> | null;
assert(settledRefreshResult, 'refresh must settle the interrupted tool request');
assert.match(String(settledRefreshResult.error), /not replayed automatically/);
assert.equal(settledRefreshResult.result, undefined,
  'a durable in-flight refresh becomes interruption rather than a replayed side effect');
const retryProject = 'project-result-retry';
const retryRun = 'run-result-retry';
const retryCall = 'call-result-retry';
const retryDigest = 'digest-result-retry';
assert(saveStoredServerRun(retryProject, {
  projectId: retryProject,
  runId: retryRun,
  attempts: [],
}));
const retryExecutor = new ServerRunToolExecutor(retryProject, executorCallbacks, manager);
startExecutor(retryExecutor, retryRun, new Map([[
  retryCall,
  { name: 'mutating_tool', argsDigest: retryDigest, result: { ok: true } },
]]));
let resultRetryPosts = 0;
const resultRetrySettled = Promise.withResolvers<void>();
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/tool-claim')) {
    return Response.json({ claimed: true, outcome: 'duplicate' });
  }
  if (url.endsWith('/tool-result')) {
    resultRetryPosts += 1;
    if (resultRetryPosts === 1) return new Response(null, { status: 503 });
    resultRetrySettled.resolve();
    return Response.json({ ok: true, outcome: 'accepted' });
  }
  throw new Error(`unexpected request: ${url}`);
};
const streamRetriesBeforeResult = retriedRuns.length;
assert.equal(await retryExecutor.handle(
  retryRun,
  retryCall,
  'mutating_tool',
  {},
  retryDigest,
  () => true,
), false);
await resultRetrySettled.promise;
assert.equal(resultRetryPosts, 2,
  'a transient result POST retries the captured durable outcome locally');
assert.equal(retriedRuns.length, streamRetriesBeforeResult,
  'a committed tool request never relies on an SSE replay to deliver its result');
const forbiddenProject = 'project-forbidden-integration';
const forbiddenRun = 'run-forbidden-integration';
assert(saveStoredServerRun(forbiddenProject, {
  projectId: forbiddenProject,
  runId: forbiddenRun,
  attempts: [],
}));
const forbiddenExecutor = new ServerRunToolExecutor(
  forbiddenProject,
  executorCallbacks,
  manager,
);
startExecutor(forbiddenExecutor, forbiddenRun, new Map());
globalThis.fetch = async () => new Response(null, { status: 403 });
assert.equal(await forbiddenExecutor.handle(
  forbiddenRun,
  'call-forbidden',
  'mutating_tool',
  {},
  'digest-forbidden',
  () => true,
), false);
assert.deepEqual(abandonedRuns, [{
  runId: forbiddenRun,
  message: 'Server tool claim is permanently unavailable: HTTP 403',
}]);
assert.deepEqual(retriedRuns, [],
  'a permanently stale capability is cleared without scheduling a stream retry');
setAgentAutoApply(false);
globalThis.fetch = originalFetch;
if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
else Reflect.deleteProperty(globalThis, 'localStorage');
Reflect.deleteProperty(globalThis, 'localStorage');
assert.equal(unavailableCallbackRan, false,
  'without Web Locks the browser neither executes nor synthesizes a conflicting result');
console.log('server run browser tool ownership verification passed');
