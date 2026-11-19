import { pauseBrowserServerRun, restoreContinuationMessages } from './serverRunPause';
import { acknowledgeContinuation } from './serverRunContinue';
import { useEffect, useRef } from 'react';
import type { ProjectDoc } from '../editor/types';
import {
  recoveredServerRunTerminal,
  serverRunNeedsResume,
  requestServerRunResume,
  requestServerRunStart,
  serverRunShouldResume,
} from './serverRunProtocol';
import { reconcileRunEvidence, submitExistingRunOutcomes, type RunEvidenceRecheck } from './serverRunToolReconcileClient';
import { adoptServerRunBaseline } from './serverRunRecoveryBaseline';
import {
  isPermanentServerRunRecoveryError,
  recoveredToolMap,
  restoredRunMessages,
  shouldRetryPendingServerRunAdmission,
} from './serverRunRecovery';
import {
  clearStoredServerRunLease,
  clearStoredServerRun,
  patchStoredServerRun,
  readStoredServerRun,
  type StoredServerRun,
} from './serverRunSessionStorage';
import {
  prepareServerRunRecovery,
  type ServerRunRecoveryPreparation,
} from './serverRunRecoveryPreparation';
import { releaseServerRunOwnership } from './serverRunOwnership';
import type { ServerRunControllerActions } from './serverRunControllerActions';
import type { ServerRunState } from './serverRunState';
import type { ServerRunStreamLifecycle } from './serverRunStreamLifecycle';

interface RecoveryContext {
  readonly projectId: string;
  readonly stored: StoredServerRun;
  readonly state: ServerRunState;
  readonly stream: ServerRunStreamLifecycle;
  readonly alive: { current: boolean };
}

type ActiveRecovery = Extract<ServerRunRecoveryPreparation, { readonly kind: 'active' }>;

function detachRecovery(state: ServerRunState): void {
  state.eventSession.close();
  state.toolExecutor.stop();
  state.refs.abort.current = null;
}

function initializeRecovery(context: RecoveryContext): void {
  const { refs } = context.state;
  refs.runId.current = context.stored.runId;
  refs.runProject.current = context.projectId;
  refs.running.current = true;
  refs.assistantText.current = context.stored.assistantText ?? '';
  refs.assistantThinking.current = context.stored.assistantThinking ?? '';
  refs.activeOptions.current = refs.options.current;
  refs.runExecutor.current = context.state.toolExecutor;
  context.state.setRunning(true);
}

export async function finishLocalTerminal(context: RecoveryContext, metadata?: ActiveRecovery['metadata']): Promise<void> {
  const { state, projectId, stored } = context;
  if (stored.continuationTurns?.length || stored.pendingContinuation) {
    const text = metadata?.recovery?.replayBase?.terminalText;
    const commit = state.refs.options.current.session?.commitModelTurn;
    if (typeof text !== 'string' || !commit
      || (stored.pendingContinuation && metadata?.recovery?.lastContinuationId !== stored.pendingContinuation.id)) {
      freezeRecoveredRun(context, { blocked: true, metadata: metadata ?? {}, existingOutcomes: [], decisions: [],
        summary: '任务已结束，完整回复或继续指令的接收凭据尚不可核对。历史与草稿已保留，请重新核对或结束任务。' });
      return;
    }
    acknowledgeContinuation(projectId, metadata!);
    if (!patchStoredServerRun(projectId, { assistantText: text, assistantThinking: '',
      cursor: metadata?.lastEventId ?? stored.cursor })) throw new Error('Browser durable storage could not persist final reply.');
    state.refs.assistantText.current = text;
    state.refs.assistantThinking.current = '';
    restoreRecoveryMessages({ ...context, stored: readStoredServerRun(projectId) ?? stored });
    await commit(stored.runId, stored.modelHistoryLength ?? Number.MAX_SAFE_INTEGER, stored.content ?? stored.text ?? '', text);
  }
  await state.refs.options.current.onRunAbandon?.(stored.runId);
  clearStoredServerRun(projectId, stored.runId);
  releaseServerRunOwnership(projectId, stored.runId);
  state.refs.runId.current = null;
  state.refs.running.current = false;
  state.refs.runExecutor.current = null;
  state.setRunning(false);
}

function releaseInactiveRecovery(context: RecoveryContext): void {
  context.state.refs.runId.current = null;
  context.state.refs.running.current = false;
  context.state.refs.runExecutor.current = null;
  context.state.setRunning(false);
  context.state.eventSession.resetRecovery();
}

async function admitPendingRun(
  context: RecoveryContext,
  capability: string,
  baseDoc: ProjectDoc,
): Promise<void> {
  const { stored, projectId, state } = context;
  if (!stored.admissionPending) return;
  await state.refs.options.current.onRunPrepare?.({
    runId: stored.runId,
    text: stored.text ?? '',
    content: stored.content ?? stored.text ?? '',
    askOnly: stored.askOnly === true,
    references: stored.references ?? [],
    baseDoc,
  });
  await requestServerRunStart(projectId, stored.runId, capability);
  if (!patchStoredServerRun(projectId, { admissionPending: false })) {
    throw new Error('Browser durable storage could not complete run admission.');
  }
}

function recoveryCurrent(context: RecoveryContext): boolean {
  return context.alive.current && context.state.refs.enabled.current
    && context.state.refs.runId.current === context.stored.runId
    && readStoredServerRun(context.projectId)?.runId === context.stored.runId;
}

function freezeRecoveredRun(context: RecoveryContext, evidence: RunEvidenceRecheck): void {
  const { state, stored } = context;
  state.eventSession.close();
  state.toolExecutor.stop();
  state.refs.frozenRun.current = stored.runId;
  // Keep the send guard until the user explicitly ends this unresolved run.
  state.refs.running.current = true;
  state.setRunning(false);
  state.setLiveTool(null);
  state.updateMessages((messages) => {
    const card = { role: 'error' as const, text: evidence.summary, reconcile: {
      reason: evidence.summary,
      targets: evidence.decisions.flatMap((entry) => entry.decision.targets),
      evidenceVersion: 0,
    } };
    const index = messages.findLastIndex((message) => message.reconcile !== undefined);
    if (index < 0) return [...messages, card];
    return messages.map((message, position) => position === index
      ? { ...card, reconcile: { ...card.reconcile,
        evidenceVersion: message.reconcile!.evidenceVersion + 1 } }
      : message);
  });
  releaseServerRunOwnership(context.projectId, stored.runId);
}

/** Reconcile existing effects, prepare the browser, then request execution authority. */
async function startRecoveredBrowserRun(
  context: RecoveryContext,
  prepared: ActiveRecovery,
): Promise<boolean> {
  const { state, stored } = context;
  const paused = prepared.metadata.status === 'paused' || prepared.metadata.recovery?.state === 'paused';
  const baseDoc = state.refs.context.current.getDoc();
  if (!prepared.metadata.recovery || prepared.metadata.recovery.state === 'admitted') {
    await admitPendingRun(context, prepared.capability, baseDoc);
  }
  if (!recoveryCurrent(context)) return false;
  if (prepared.metadata.recovery) {
    let evidence = await reconcileRunEvidence(
      context.projectId, stored.runId, prepared.capability, baseDoc,
    );
    if (!recoveryCurrent(context)) return false;
    if (evidence.existingOutcomes.length) {
      // Existing results may be delivered before execution authority is
      // restored. This path never executes tools or manufactures a failure.
      await submitExistingRunOutcomes(context.projectId, stored.runId,
        prepared.capability, evidence, () => recoveryCurrent(context));
      if (!recoveryCurrent(context)) return false;
      evidence = await reconcileRunEvidence(
        context.projectId, stored.runId, prepared.capability, baseDoc,
      );
      if (!recoveryCurrent(context)) return false;
    }
    if (evidence.blocked) {
      freezeRecoveredRun(context, evidence);
      return false;
    }
    prepared = { ...prepared, metadata: evidence.metadata };
  }
  if (!recoveryCurrent(context)) return false;
  const recovery = stored.text && stored.content
    ? await state.refs.options.current.onRunStart?.({
      runId: stored.runId,
      text: stored.text,
      content: stored.content,
      askOnly: stored.askOnly === true,
      references: stored.references ?? [],
      baseDoc,
      resumed: true,
      ...(prepared.metadata.recovery?.tools
        ? { durableTools: prepared.metadata.recovery.tools }
        : {}),
    })
    : undefined;
  if (!recoveryCurrent(context)) return false;
  if (recovery?.blocked) {
    state.refs.frozenRun.current = stored.runId;
    state.eventSession.close();
    return false;
  }
  if (paused || prepared.metadata.status === 'paused' || prepared.metadata.recovery?.state === 'paused') {
    pauseBrowserServerRun(context.projectId, state, prepared.metadata.recovery?.lastError ?? undefined);
    return false;
  }
  patchStoredServerRun(context.projectId, { paused: false });
  state.refs.abort.current = new AbortController();
  state.toolExecutor.start({
    capability: prepared.capability,
    baseDoc: recovery?.baseDoc ?? baseDoc,
    draftDoc: recovery?.draftDoc,
    activation: prepared.activation,
    runId: stored.runId,
    abort: state.refs.abort.current,
    recovered: recoveredToolMap(recovery?.tools ?? []),
  });
  if (serverRunNeedsResume(prepared.metadata)) {
    const authority = await requestServerRunResume(
      context.projectId, stored.runId, prepared.capability, {
        expectedRevision: prepared.metadata.recovery!.revision,
        recorderId: stored.recorderId ?? context.projectId,
        cursor: prepared.cursor,
      },
    );
    if (!recoveryCurrent(context)) return false;
    if (!authority.ok) {
      state.toolExecutor.stop();
      // The browser is prepared, but a lease or revision race still prevents
      // model execution. Retry from fresh evidence without dispatching tools.
      throw new Error(`服务端暂未允许恢复该任务：${authority.reason ?? `HTTP ${authority.status}`}`);
    }
  }
  patchStoredServerRun(context.projectId, { admissionPending: false });
  // Recoverable tool results were reconciled against durable state above. The legacy path
  // retains its established recovery behaviour for other backends.
  if (!prepared.metadata.recovery) await state.toolExecutor.reconcileStoredAttempts(
    stored.runId, stored.attempts ?? [],
  );
  state.refs.frozenRun.current = null;
  state.updateMessages((messages) => {
    const index = messages.findLastIndex((message) => message.reconcile !== undefined);
    return index < 0 ? messages : messages.map((message, position) => position === index
      ? { role: 'note', text: '核对完成，已获得服务端确认并恢复任务。' } : message);
  });
  state.refs.running.current = true;
  state.setRunning(true);
  return true;
}

function restoreRecoveryMessages(context: RecoveryContext): void {
  const { stored, state } = context;
  if (!stored.text) return;
  const turns = stored.continuationTurns ?? [];
  state.updateMessages((current) => restoreContinuationMessages(
    turns.some((turn) => current.some((message) => message.continuationId === turn.id)) ? current : restoredRunMessages(
    current,
    stored.text!,
    turns[0]?.previousAssistantText ?? stored.assistantText ?? '',
    turns.length ? '' : stored.assistantThinking ?? '',
  ), stored));
}

export async function continueActiveRecovery(
  context: RecoveryContext,
  prepared: ActiveRecovery,
): Promise<void> {
  acknowledgeContinuation(context.projectId, prepared.metadata);
  context = { ...context, stored: readStoredServerRun(context.projectId) ?? context.stored };
  const { state, stored, projectId } = context;
  const baseline = adoptServerRunBaseline(projectId, state, prepared.metadata, stored.cursor ?? 0);
  if (baseline.adoptedBaseline) {
    context = { ...context, stored: readStoredServerRun(projectId) ?? stored };
  }
  state.refs.cursor.current = prepared.cursor;
  if (!context.alive.current || !state.refs.enabled.current) {
    releaseServerRunOwnership(projectId, stored.runId);
    state.setRunning(false);
    state.eventSession.resetRecovery();
    return;
  }
  restoreRecoveryMessages(context);
  if (!await startRecoveredBrowserRun(context, prepared)) return;
  if (prepared.baselineNotice) {
    // Say plainly that the previous stream is gone; silently resuming would make
    // the interrupted output look like the model's completed answer.
    state.updateMessages((messages) => [
      ...messages,
      { role: 'note', text: `${prepared.baselineNotice}上次输出已中断。` },
    ]);
  }
  state.refs.terminalRun.current = null;
  state.eventSession.resetRecovery();
  const terminalStatus = recoveredServerRunTerminal(prepared.metadata, prepared.cursor);
  if (terminalStatus) await context.stream.finishRun(stored.runId, terminalStatus);
  else context.stream.subscribe(stored.runId);
}

async function applyRecoveryPreparation(
  context: RecoveryContext,
  prepared: ServerRunRecoveryPreparation,
): Promise<void> {
  if (prepared.kind === 'inactive') return;
  if (prepared.kind === 'local_terminal') {
    const baseline = adoptServerRunBaseline(context.projectId, context.state, prepared.metadata, context.stored.cursor ?? 0);
    if (baseline.adoptedBaseline) {
      restoreRecoveryMessages({ ...context, stored: readStoredServerRun(context.projectId) ?? context.stored });
      context.state.appendMessage({ role: 'note', text: baseline.reason ?? '已按服务端显示基线恢复。' });
    }
    await finishLocalTerminal(context, prepared.metadata);
    return;
  }
  if (prepared.kind === 'proposal' && context.stored.leaseToken) {
    clearStoredServerRunLease(
      context.projectId,
      context.stored.runId,
      context.stored.leaseToken,
    );
  }
  if (prepared.kind === 'owned_elsewhere' || prepared.kind === 'proposal') {
    releaseInactiveRecovery(context);
    return;
  }
  await continueActiveRecovery(context, prepared);
}

function handleRecoveryError(context: RecoveryContext, error: unknown): void {
  if (!recoveryCurrent(context)) return;
  const permanent = !shouldRetryPendingServerRunAdmission(context.stored, error)
    && isPermanentServerRunRecoveryError(error);
  if (permanent) {
    context.alive.current = false;
    context.stream.abandonStaleRecovery(context.stored.runId, error);
  } else {
    context.state.eventSession.scheduleRecovery(() => {
      if (recoveryCurrent(context)) void context.state.refs.recover.current?.(context.stored.runId);
    });
  }
}

async function recoverServerRun(context: RecoveryContext): Promise<void> {
  try {
    if (!recoveryCurrent(context)) return;
    context.state.refs.capability.current = context.stored.capability ?? null;
    const prepared = await prepareServerRunRecovery(
      context.projectId,
      context.stored,
      () => context.alive.current && context.state.refs.enabled.current,
    );
    await applyRecoveryPreparation(context, prepared);
  } catch (error) {
    handleRecoveryError(context, error);
  }
}
function stopRecovery(context: RecoveryContext): void {
  context.alive.current = false;
  detachRecovery(context.state);
}


export function useServerRunRecoveryLifecycle(
  projectId: string,
  enabled: boolean,
  hydrated: boolean | undefined,
  state: ServerRunState,
  stream: ServerRunStreamLifecycle,
  actions: ServerRunControllerActions,
): void {
  const stateRef = useRef(state);
  const streamRef = useRef(stream);
  const actionsRef = useRef(actions);
  stateRef.current = state;
  streamRef.current = stream;
  actionsRef.current = actions;
  useEffect(() => {
    const current = stateRef.current;
    let alive = true;
    let activeContext: RecoveryContext | null = null;
    let pending: { readonly runId: string; readonly promise: Promise<void> } | null = null;
    const recover = (runId: string): Promise<void> => {
      if (pending?.runId === runId) return pending.promise;
      const stored = readStoredServerRun(projectId);
      if (!alive || !current.refs.enabled.current || !current.refs.ready.current
        || !stored || stored.runId !== runId) return Promise.resolve();
      if (activeContext) activeContext.alive.current = false;
      current.eventSession.close();
      current.toolExecutor.stop();
      activeContext = {
        projectId, stored, state: current, stream: streamRef.current,
        alive: { current: true },
      };
      initializeRecovery(activeContext);
      const promise = recoverServerRun(activeContext).finally(() => {
        if (pending?.promise === promise) pending = null;
      });
      pending = { runId, promise };
      return promise;
    };
    current.refs.recover.current = recover;
    if (!enabled || !current.refs.ready.current) {
      const runId = current.refs.runId.current;
      detachRecovery(current);
      if (!enabled && runId && current.refs.running.current) actionsRef.current.stop();
    } else {
      const stored = readStoredServerRun(projectId);
      if (stored && serverRunShouldResume(true, stored.projectId, projectId)) void recover(stored.runId);
    }
    return () => {
      alive = false;
      if (current.refs.recover.current === recover) current.refs.recover.current = null;
      if (activeContext) stopRecovery(activeContext);
      else detachRecovery(current);
    };
  }, [enabled, hydrated, projectId]);
}
