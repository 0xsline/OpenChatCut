import { useEffect, useRef } from 'react';
import type { ProjectDoc } from '../editor/types';
import {
  recoveredServerRunTerminal,
  requestServerRunStart,
  serverRunShouldResume,
} from './serverRunProtocol';
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
  refs.activeOptions.current = refs.options.current;
  refs.runExecutor.current = context.state.toolExecutor;
  context.state.setRunning(true);
}

async function finishLocalTerminal(context: RecoveryContext): Promise<void> {
  const { state, projectId, stored } = context;
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

async function startRecoveredBrowserRun(
  context: RecoveryContext,
  prepared: ActiveRecovery,
): Promise<void> {
  const { state, stored } = context;
  const baseDoc = state.refs.context.current.getDoc();
  await admitPendingRun(context, prepared.capability, baseDoc);
  const recovery = stored.text && stored.content
    ? await state.refs.options.current.onRunStart?.({
      runId: stored.runId,
      text: stored.text,
      content: stored.content,
      askOnly: stored.askOnly === true,
      references: stored.references ?? [],
      baseDoc,
      resumed: true,
    })
    : undefined;
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
  await state.toolExecutor.reconcileStoredAttempts(
    stored.runId,
    stored.attempts ?? [],
  );
}

function restoreRecoveryMessages(context: RecoveryContext): void {
  const { stored, state } = context;
  if (!stored.text) return;
  state.updateMessages((current) => restoredRunMessages(
    current,
    stored.text!,
    stored.assistantText ?? '',
  ));
}

async function continueActiveRecovery(
  context: RecoveryContext,
  prepared: ActiveRecovery,
): Promise<void> {
  const { state, stored, projectId } = context;
  state.refs.cursor.current = prepared.cursor;
  if (!context.alive.current || !state.refs.enabled.current) {
    releaseServerRunOwnership(projectId, stored.runId);
    state.setRunning(false);
    state.eventSession.resetRecovery();
    return;
  }
  await startRecoveredBrowserRun(context, prepared);
  restoreRecoveryMessages(context);
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
    await finishLocalTerminal(context);
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
  if (!context.alive.current || !context.state.refs.enabled.current) return;
  const permanent = !shouldRetryPendingServerRunAdmission(context.stored, error)
    && isPermanentServerRunRecoveryError(error);
  if (permanent) {
    context.alive.current = false;
    context.stream.abandonStaleRecovery(context.stored.runId, error);
  } else {
    context.state.eventSession.scheduleRecovery(() => { void recoverServerRun(context); });
  }
}

async function recoverServerRun(context: RecoveryContext): Promise<void> {
  try {
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
    if (!enabled || !current.refs.ready.current) {
      const runId = current.refs.runId.current;
      detachRecovery(current);
      if (!enabled && runId && current.refs.running.current) actionsRef.current.stop();
      return undefined;
    }
    const stored = readStoredServerRun(projectId);
    if (!stored || !serverRunShouldResume(true, stored.projectId, projectId)) {
      return () => { detachRecovery(current); };
    }
    const context: RecoveryContext = {
      projectId,
      stored,
      state: current,
      stream: streamRef.current,
      alive: { current: true },
    };
    initializeRecovery(context);
    void recoverServerRun(context);
    return () => { stopRecovery(context); };
  }, [enabled, hydrated, projectId]);
}
