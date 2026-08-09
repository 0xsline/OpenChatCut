import assert from 'node:assert/strict';
import { makeDraft, replayActions } from '../editor/store';
import { activeTimeline } from '../editor/types';
import { INITIAL } from '../editor/initial';
import { docFromTimeline } from '../persist/projectStore';
import { ExternalCallCancellationRegistry } from './external-call-cancellation';
import { ExternalBridgeRuntime, type ExternalBridgeBinding } from './external-bridge-runtime';
import {
  captureExternalToolActions,
  createExternalEditSession,
  ExternalEditSessionOutcomeError,
  finishExternalEditSession,
  forkExternalEditSession,
  isExternalEditSessionStale,
  restoreExternalEditSession,
  reviewExternalEditSession,
  revisionOf,
} from './external-edit-session';
import {
  isExternalDraftTool,
  isExternalGlobalReadTool,
  isExternalReadTool,
  isExternalRealTool,
} from './external-tool-policy';
import { externalToolSchemas } from './external-tool-schemas';
import { ASK_MODE_TOOL_SCHEMAS } from './ask-mode-tools';
import {
  executeExternalCall,
  externalBridgeReadinessMatches,
  hydrateExternalBridge,
  type ExternalBridgeReadinessToken,
  type ExternalResultSender,
} from './useExternalAgentBridge';

const base = docFromTimeline({ ...INITIAL, items: [] });
function sessionStatus(value: unknown): unknown {
  assert(value && typeof value === 'object' && 'status' in value);
  return value.status;
}
const cancellationBeforeRegister = new ExternalCallCancellationRegistry();
cancellationBeforeRegister.cancel('late-call', 'transport closed');
assert.equal(cancellationBeforeRegister.tombstoneCount, 1);
const lateCall = new AbortController();
cancellationBeforeRegister.register('late-call', lateCall);
assert.equal(lateCall.signal.aborted, true, 'a cancellation received before call registration is not lost');
assert.equal(lateCall.signal.reason, 'transport closed');
assert.equal(cancellationBeforeRegister.tombstoneCount, 0);
cancellationBeforeRegister.release('late-call');

const ownerA = new ExternalCallCancellationRegistry();
const ownerB = new ExternalCallCancellationRegistry();
ownerA.cancel('shared-id', 'owner A cancelled');
const ownerBCall = new AbortController();
ownerB.register('shared-id', ownerBCall);
assert.equal(ownerBCall.signal.aborted, false, 'cancellation tombstones remain isolated to one editor bridge');
const ownerACall = new AbortController();
ownerA.register('shared-id', ownerACall);
assert.equal(ownerACall.signal.aborted, true);
ownerA.abortAll();
ownerB.abortAll();

let cancellationClock = 0;
const expiringCancellations = new ExternalCallCancellationRegistry(2, 10, () => cancellationClock);
expiringCancellations.cancel('expired', 'old cancellation');
cancellationClock = 11;
const expiredCall = new AbortController();
expiringCancellations.register('expired', expiredCall);
assert.equal(expiredCall.signal.aborted, false, 'expired cancellation tombstones cannot cancel later calls');
expiringCancellations.cancel('oldest', 'oldest cancellation');
expiringCancellations.cancel('middle', 'middle cancellation');
expiringCancellations.cancel('newest', 'newest cancellation');
assert.equal(expiringCancellations.tombstoneCount, 2, 'cancellation tombstones stay bounded');
const evictedCall = new AbortController();
expiringCancellations.register('oldest', evictedCall);
assert.equal(evictedCall.signal.aborted, false, 'the oldest tombstone is evicted at the bound');
const retainedCall = new AbortController();
expiringCancellations.register('middle', retainedCall);
assert.equal(retainedCall.signal.aborted, true);
expiringCancellations.abortAll();
const concurrentBinding: ExternalBridgeBinding = {
  projectId: 'runtime-project',
  editorInstanceId: 'runtime-editor',
  baseRevision: revisionOf(base),
};
const concurrentPending = new Map<string, (value: unknown) => void>();
const concurrentSignals = new Map<string, AbortSignal>();
const concurrentRuntime = {
  execute(
    name: string,
    _args: Record<string, unknown>,
    _binding: ExternalBridgeBinding,
    signal?: AbortSignal,
  ): Promise<unknown> {
    assert(signal);
    concurrentSignals.set(name, signal);
    let resolvePending!: (value: unknown) => void;
    let rejectPending!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const cancel = () => rejectPending(new ExternalEditSessionOutcomeError('cancelled', 'call cancelled'));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    concurrentPending.set(name, (value) => {
      signal.removeEventListener('abort', cancel);
      resolvePending(value);
    });
    return promise;
  },
};
const concurrentBridge = new AbortController();
const concurrentCancellations = new ExternalCallCancellationRegistry();
const delivered: Array<{ id: string; outcome: string }> = [];
const deliverResult: ExternalResultSender = async (id, outcome, _value, signal) => {
  assert.equal(signal, concurrentBridge.signal, 'terminal delivery is owned by the bridge signal');
  assert.equal(signal.aborted, false);
  delivered.push({ id, outcome });
};
const cancelledCall = executeExternalCall(
  { id: 'call-a', name: 'call-a', arguments: {}, binding: concurrentBinding },
  concurrentRuntime,
  concurrentBridge.signal,
  concurrentCancellations,
  deliverResult,
);
const survivingCall = executeExternalCall(
  { id: 'call-b', name: 'call-b', arguments: {}, binding: concurrentBinding },
  concurrentRuntime,
  concurrentBridge.signal,
  concurrentCancellations,
  deliverResult,
);
concurrentCancellations.cancel('call-a', 'call timed out');
await cancelledCall;
assert.deepEqual(delivered, [{ id: 'call-a', outcome: 'cancelled' }]);
assert.equal(concurrentBridge.signal.aborted, false, 'one cancelled call does not close its editor bridge');
assert.equal(concurrentSignals.get('call-b')?.aborted, false, 'one cancelled call does not abort sibling work');
const resolveSurvivingCall = concurrentPending.get('call-b');
assert(resolveSurvivingCall);
resolveSurvivingCall({ ok: true });
await survivingCall;
assert.deepEqual(delivered, [
  { id: 'call-a', outcome: 'cancelled' },
  { id: 'call-b', outcome: 'applied' },
]);

const closingBridge = new AbortController();
const closingCancellations = new ExternalCallCancellationRegistry();
const closingOutcomes: string[] = [];
const rejectClosedDelivery: ExternalResultSender = async (_id, outcome, _value, signal) => {
  closingOutcomes.push(outcome);
  assert.equal(signal, closingBridge.signal);
  assert.equal(signal.aborted, true);
  throw new Error('bridge closed');
};
const closingCalls = ['close-a', 'close-b'].map((id) => executeExternalCall(
  { id, name: id, arguments: {}, binding: concurrentBinding },
  concurrentRuntime,
  closingBridge.signal,
  closingCancellations,
  rejectClosedDelivery,
));
closingBridge.abort('transport closed');
const closingResults = await Promise.allSettled(closingCalls);
assert(closingResults.every((result) => result.status === 'rejected'));
assert.equal(concurrentSignals.get('close-a')?.aborted, true);
assert.equal(concurrentSignals.get('close-b')?.aborted, true);
assert.deepEqual(closingOutcomes.sort(), ['cancelled', 'cancelled']);
closingCancellations.abortAll();
const tokenA: ExternalBridgeReadinessToken = {
  projectId: 'project-a',
  editorInstanceId: 'editor-a',
  runtimeIdentity: {},
};
const tokenB: ExternalBridgeReadinessToken = {
  projectId: 'project-b',
  editorInstanceId: 'editor-b',
  runtimeIdentity: {},
};
let currentProjectId = tokenA.projectId;
let currentRuntimeToken: ExternalBridgeReadinessToken | null = tokenA;
let readyRuntimeToken: ExternalBridgeReadinessToken | null = tokenA;
const bridgeStarts: string[] = [];
const startReadyBridge = () => {
  if (
    readyRuntimeToken
    && currentRuntimeToken
    && externalBridgeReadinessMatches(readyRuntimeToken, currentRuntimeToken, currentProjectId)
  ) {
    bridgeStarts.push(readyRuntimeToken.editorInstanceId);
  }
};
startReadyBridge();
currentProjectId = tokenB.projectId;
currentRuntimeToken = tokenB;
startReadyBridge();
assert.deepEqual(
  bridgeStarts,
  ['editor-a'],
  'switching projects invalidates the old readiness before the new runtime hydrates',
);

let resolveBHydration!: (value: null) => void;
const bHydrationPending = new Promise<null>((resolve) => { resolveBHydration = resolve; });
let bHydrateCount = 0;
const bHydration = hydrateExternalBridge(
  tokenB.projectId,
  {
    hydrate: async () => { bHydrateCount += 1; },
  },
  () => currentRuntimeToken?.runtimeIdentity === tokenB.runtimeIdentity,
  (message) => { throw new Error(message); },
  () => {
    readyRuntimeToken = tokenB;
    startReadyBridge();
  },
  async (projectId) => {
    assert.equal(projectId, tokenB.projectId);
    return bHydrationPending;
  },
);
assert.equal(bHydrateCount, 0);
assert.deepEqual(bridgeStarts, ['editor-a'], 'register/poll cannot start before B hydration resolves');
resolveBHydration(null);
await bHydration;
assert.equal(bHydrateCount, 1);
assert.deepEqual(bridgeStarts, ['editor-a', 'editor-b'], 'B starts exactly once after hydration');

const lateTokenA: ExternalBridgeReadinessToken = {
  projectId: 'project-a',
  editorInstanceId: 'editor-a-late',
  runtimeIdentity: {},
};
currentProjectId = lateTokenA.projectId;
currentRuntimeToken = lateTokenA;
let resolveLateA!: (value: null) => void;
const lateAPending = new Promise<null>((resolve) => { resolveLateA = resolve; });
let lateAHydrateCount = 0;
const lateAHydration = hydrateExternalBridge(
  lateTokenA.projectId,
  {
    hydrate: async () => { lateAHydrateCount += 1; },
  },
  () => currentRuntimeToken?.runtimeIdentity === lateTokenA.runtimeIdentity,
  (message) => { throw new Error(message); },
  () => {
    readyRuntimeToken = lateTokenA;
    startReadyBridge();
  },
  async () => lateAPending,
);
currentProjectId = tokenB.projectId;
currentRuntimeToken = tokenB;
readyRuntimeToken = tokenB;
resolveLateA(null);
await lateAHydration;
assert.equal(lateAHydrateCount, 0);
assert.equal(readyRuntimeToken, tokenB, 'a late A hydration cannot overwrite B readiness');
assert.deepEqual(bridgeStarts, ['editor-a', 'editor-b']);

const tokenC: ExternalBridgeReadinessToken = {
  projectId: 'project-c',
  editorInstanceId: 'editor-c',
  runtimeIdentity: {},
};
let resolveC!: (value: null) => void;
const cPending = new Promise<null>((resolve) => { resolveC = resolve; });
let cHydrateCount = 0;
currentProjectId = tokenC.projectId;
currentRuntimeToken = tokenC;
const cHydration = hydrateExternalBridge(
  tokenC.projectId,
  {
    hydrate: async () => { cHydrateCount += 1; },
  },
  () => currentRuntimeToken?.runtimeIdentity === tokenC.runtimeIdentity,
  (message) => { throw new Error(message); },
  () => {
    readyRuntimeToken = tokenC;
    startReadyBridge();
  },
  async () => cPending,
);
currentRuntimeToken = null;
resolveC(null);
await cHydration;
assert.equal(cHydrateCount, 0);
assert.equal(readyRuntimeToken, tokenB, 'unmounted hydration cannot publish readiness or leak a bridge');
assert.deepEqual(bridgeStarts, ['editor-a', 'editor-b']);

const session = createExternalEditSession(base, 'Codex');
assert.equal(session.status, 'drafting');
assert.equal(session.approvalMode, 'manual');
assert.match(session.baseRevision, /^v\d+-[0-9a-f]{8}$/);
assert.equal(isExternalEditSessionStale(session, base), false);
const reorderedBase = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
assert.equal(
  revisionOf(reorderedBase),
  revisionOf(base),
  'semantic revisions are stable across JSON object-key order changes',
);

const autoSession = createExternalEditSession(base, 'Codex', 'auto');
assert.equal(autoSession.approvalMode, 'auto');
assert.throws(() => createExternalEditSession(base, 'Codex', 'invalid'), /approvalMode/);

const isolatedCall = forkExternalEditSession(session);
isolatedCall.draft!.commands.setAspect(1080, 1920, 'contain');
const staged = captureExternalToolActions(
  isolatedCall,
  'set_aspect_ratio',
  { width: 1080, height: 1920 },
);
assert.equal(activeTimeline(base).width, 1920, 'live/base project must remain unchanged while drafting');
assert.equal(staged.draft!.getState().width, 1080);
assert.equal(staged.operations.length, 1);

const reviewed = reviewExternalEditSession(staged, 'Create a vertical cut');
assert.equal(reviewed.status, 'awaiting_review');
assert.equal(reviewed.draft, null);
assert.equal(reviewed.proposal?.title, 'Codex');
assert.equal(reviewed.proposal?.summary, 'Create a vertical cut');

const actions = reviewed.proposal!.options[0].operations.flatMap((operation) => operation.actions);
const applied = replayActions(base, actions);
assert.equal(activeTimeline(applied).width, 1080);
assert.equal(activeTimeline(applied).height, 1920);
assert.equal(isExternalEditSessionStale(session, applied), true);

const restored = restoreExternalEditSession({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'auto',
  status: 'rejected',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal!,
}, base);
assert.equal(restored.status, 'rejected');
assert.equal(restored.approvalMode, 'auto');
assert.equal(restored.proposal, null);
const restoredLegacyDiscard = restoreExternalEditSession({
  sessionId: session.id,
  clientName: session.clientName,
  status: 'discarded',
  baseRevision: session.baseRevision,
  createdAt: session.createdAt,
  operationCount: staged.operationCount,
  proposal: null,
}, base);
assert.equal(restoredLegacyDiscard.status, 'cancelled', 'legacy discarded sessions normalize to cancelled');
assert.equal(restoredLegacyDiscard.operationCount, 1);
assert.equal(restoredLegacyDiscard.approvalMode, 'manual');

for (const outcome of ['applied', 'rejected', 'cancelled', 'stale', 'failed'] as const) {
  assert.equal(finishExternalEditSession(session, outcome).status, outcome);
}


const live = makeDraft(base);
const runtime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: live.commands,
    getState: live.getState,
    getDoc: live.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
const runtimeBinding = {
  projectId: 'runtime-project',
  editorInstanceId: 'runtime-editor',
  baseRevision: revisionOf(base),
};
const missingSkill = await runtime.execute(
  'load_skill',
  { name: 'missing-skill-check' },
  runtimeBinding,
);
assert(
  missingSkill
    && typeof missingSkill === 'object'
    && 'error' in missingSkill
    && String(missingSkill.error).includes('no such skill'),
  'stateless skill reads execute without an edit session',
);
const begun = await runtime.execute('begin_edit_session', {}, runtimeBinding);
assert(begun && typeof begun === 'object' && 'editSessionId' in begun);

// Real-project tools are confirm-gated: the first call returns
// needs_confirmation and queues a guard; confirming allows the next call.
const guarded = await runtime.execute(
  'read_export_history',
  { editSessionId: begun.editSessionId },
  runtimeBinding,
);
assert(
  guarded && typeof guarded === 'object' && (guarded as { needs_confirmation?: boolean }).needs_confirmation === true,
  'real-project tools ask for confirmation before the first call',
);
const guard = runtime.pendingGuard();
assert(guard && guard.tool === 'read_export_history', 'pending guard surfaces the requested tool');
runtime.confirmRealTool(guard!.id, true);
const released = await runtime.execute(
  'read_export_history',
  { editSessionId: begun.editSessionId },
  runtimeBinding,
);
assert(!(released && typeof released === 'object' && (released as { needs_confirmation?: boolean }).needs_confirmation),
  'confirmed real-project tool executes without asking again');
runtime.confirmRealTool(guard!.id, false);
assert(runtime.pendingGuard() === null, 'resolved guards leave the pending set');

const draftingInfo = await runtime.execute(
  'get_edit_session',
  { editSessionId: begun.editSessionId },
  runtimeBinding,
);
assert.equal(sessionStatus(draftingInfo), 'drafting');
await assert.rejects(
  runtime.execute('get_edit_session', { editSessionId: begun.editSessionId }, {
    ...runtimeBinding,
    projectId: 'other-project',
  }),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
);
await assert.rejects(
  runtime.execute('begin_edit_session', {}, runtimeBinding, lateCall.signal),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'cancelled'
  ),
  'a cancellation tombstone produces the cancelled terminal outcome before execution',
);

live.commands.setAspect(1080, 1920, 'contain');
await runtime.hydrate({
  sessionId: 'runtime-applied-session',
  clientName: 'Codex',
  approvalMode: 'manual',
  status: 'applied',
  baseRevision: runtimeBinding.baseRevision,
  createdAt: Date.now(),
  operationCount: 1,
  appliedOperationCount: 1,
  proposal: null,
});
await assert.rejects(
  runtime.execute(
    'get_edit_session',
    { editSessionId: 'runtime-applied-session' },
    runtimeBinding,
  ),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
  'hydration cannot fabricate the exact revision produced by a prior UI apply',
);
await assert.rejects(
  runtime.execute(
    'set_aspect_ratio',
    {
      editSessionId: 'runtime-applied-session',
      width: 1920,
      height: 1080,
    },
    runtimeBinding,
  ),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
  'mutating tools retain strict base-revision validation',
);
await assert.rejects(
  runtime.execute(
    'get_edit_session',
    { editSessionId: 'unknown-session' },
    runtimeBinding,
  ),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
  'unknown session ids cannot use terminal-read revision relaxation',
);

const rejectedLive = makeDraft(base);
const rejectedRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: rejectedLive.commands,
    getState: rejectedLive.getState,
    getDoc: rejectedLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
await rejectedRuntime.hydrate({
  sessionId: 'runtime-rejected-session',
  clientName: 'Codex',
  approvalMode: 'manual',
  status: 'rejected',
  baseRevision: revisionOf(base),
  createdAt: Date.now(),
  operationCount: 1,
  proposal: null,
});
const rejectedInfo = await rejectedRuntime.execute(
  'get_edit_session',
  { editSessionId: 'runtime-rejected-session' },
  runtimeBinding,
);
assert.equal(sessionStatus(rejectedInfo), 'rejected');

const reviewLive = makeDraft(base);
const reviewRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: reviewLive.commands,
    getState: reviewLive.getState,
    getDoc: reviewLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
await reviewRuntime.hydrate({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'manual',
  status: 'awaiting_review',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal,
});
const awaitingInfo = await reviewRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(awaitingInfo), 'awaiting_review');

const deferredApplyLive = makeDraft(base);
let deferredCommit: typeof base | null = null;
const deferredApplyRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: {
      ...deferredApplyLive.commands,
      applyDoc: (doc: typeof base) => {
        deferredCommit = doc;
      },
    },
    getState: deferredApplyLive.getState,
    getDoc: deferredApplyLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
  {
    saveProject: async () => ({
      projectId: 'runtime-project',
      revision: 1,
      epoch: 1,
      status: 'saved',
      saved: true,
      indexUpdated: true,
    }),
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
await deferredApplyRuntime.hydrate({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'manual',
  status: 'awaiting_review',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal,
});
await deferredApplyRuntime.apply(new Set([0]));
assert(deferredCommit, 'the UI command receives the committed document');
deferredApplyLive.commands.applyDoc(deferredCommit);
const deferredApplyInfo = await deferredApplyRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(
  sessionStatus(deferredApplyInfo),
  'applied',
  'terminal reads survive a React-style deferred project state update',
);

const warningLive = makeDraft(base);
let warningSaveCount = 0;
const warningRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: warningLive.commands,
    getState: warningLive.getState,
    getDoc: warningLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
  {
    saveProject: async (projectId) => {
      warningSaveCount += 1;
      return {
        projectId,
        revision: warningSaveCount,
        epoch: 1,
        status: 'saved',
        saved: true,
        indexUpdated: false,
      };
    },
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
await warningRuntime.hydrate({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'manual',
  status: 'awaiting_review',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal,
});
await warningRuntime.apply(new Set([0]));
assert.equal(warningSaveCount, 1, 'a successful document commit is applied exactly once');
assert.equal(activeTimeline(warningLive.getDoc()).width, 1080);
const warningInfo = await warningRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(warningInfo), 'applied');
assert(warningInfo && typeof warningInfo === 'object' && 'warning' in warningInfo);
assert.equal(
  warningInfo.warning,
  'The edit was applied, but the project list timestamp could not be updated.',
);
const repeatedWarningInfo = await warningRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(repeatedWarningInfo), 'applied');
assert.equal(warningSaveCount, 1, 'repeated terminal queries never replay the committed edit');

const failedSaveLive = makeDraft(base);
let failedSaveCount = 0;
const failedSaveRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: failedSaveLive.commands,
    getState: failedSaveLive.getState,
    getDoc: failedSaveLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
  {
    saveProject: async (projectId) => {
      failedSaveCount += 1;
      return {
        projectId,
        revision: failedSaveCount,
        epoch: 1,
        status: 'failed',
        saved: false,
        indexUpdated: false,
        error: new Error('project save failed'),
      };
    },
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
await failedSaveRuntime.hydrate({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'manual',
  status: 'awaiting_review',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal,
});
await assert.rejects(
  failedSaveRuntime.apply(new Set([0])),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'failed'
  ),
);
assert.equal(failedSaveCount, 1);
assert.equal(
  activeTimeline(failedSaveLive.getDoc()).width,
  1920,
  'a failed document commit never reaches applyDoc',
);
const failedSaveInfo = await failedSaveRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(failedSaveInfo), 'awaiting_review');
assert(isExternalDraftTool('set_aspect_ratio'));
assert(isExternalReadTool('read_project'));
assert(isExternalReadTool('search_stock_media'));
assert(isExternalReadTool('search_media'));
assert(isExternalDraftTool('apply_caption_avoidance'));
assert(isExternalDraftTool('place_graphics_in_safe_zone'));
assert(isExternalDraftTool('auto_reframe'));
assert(!isExternalDraftTool('delete_project'));
assert(!isExternalDraftTool('submit_render_job'));
assert(isExternalRealTool('submit_render_job'), 'real-project tools are exposed to external agents (confirm-gated)');
assert(isExternalRealTool('submit_image'), 'generation is confirm-gated for external agents');
assert(isExternalRealTool('import_media'), 'import is confirm-gated for external agents');
assert(isExternalGlobalReadTool('load_skill'));
assert(!isExternalDraftTool('load_skill'));
const askModeToolNames = new Set(ASK_MODE_TOOL_SCHEMAS.map((tool) => tool.name));
assert(askModeToolNames.has('load_skill'), 'Q&A mode exposes the current skill reader');
assert(askModeToolNames.has('read_project'), 'Q&A mode exposes project inspection');
assert(askModeToolNames.has('search_stock_media'), 'Q&A mode exposes read-only stock search');
assert(!askModeToolNames.has('edit_captions'), 'Q&A mode excludes draft edits');
assert(!askModeToolNames.has('submit_render_job'), 'Q&A mode excludes live side effects');
assert(
  ASK_MODE_TOOL_SCHEMAS.every(
    (tool) => isExternalGlobalReadTool(tool.name) || isExternalReadTool(tool.name),
  ),
  'every Q&A mode tool is classified read-only',
);
const externalLoadSkill = externalToolSchemas().find((tool) => tool.name === 'load_skill');
assert(externalLoadSkill, 'load_skill is exposed to external agents');
assert.equal(externalLoadSkill.annotations?.readOnlyHint, true);
assert(!('editSessionId' in (externalLoadSkill.input_schema.properties ?? {})));
assert(!externalLoadSkill.input_schema.required?.includes('editSessionId'));
const externalSubmitRender = externalToolSchemas().find((tool) => tool.name === 'submit_render_job');
assert(externalSubmitRender, 'submit_render_job is exposed to external agents');
assert.equal(externalSubmitRender.annotations?.readOnlyHint, false);
assert(externalSubmitRender.input_schema.required?.includes('editSessionId'), 'real tools carry editSessionId for the confirmation gate');

// approvalMode auto is the external YOLO: real-project tools run directly,
// without a confirmation card (fresh runtime keeps the binding valid).
const autoLive = makeDraft(base);
const autoRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: autoLive.commands,
    getState: autoLive.getState,
    getDoc: autoLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
const autoBinding = {
  projectId: 'runtime-project',
  editorInstanceId: 'runtime-editor',
  baseRevision: revisionOf(base),
};
const autoYoloSession = await autoRuntime.execute('begin_edit_session', { approvalMode: 'auto' }, autoBinding);
assert(autoYoloSession && typeof autoYoloSession === 'object' && 'editSessionId' in autoYoloSession);
const autoReleased = await autoRuntime.execute(
  'read_export_history',
  { editSessionId: autoYoloSession.editSessionId },
  autoBinding,
);
assert(!(autoReleased && typeof autoReleased === 'object' && (autoReleased as { needs_confirmation?: boolean }).needs_confirmation),
  'auto (YOLO) sessions run real-project tools without a confirmation card');

console.log('external edit session checks passed');
