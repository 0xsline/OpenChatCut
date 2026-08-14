import { useCallback, useRef } from 'react';
import {
  bindServerRunEvents,
  type ServerRunEventCommit,
} from './serverRunEvents';
import {
  openServerRunEventStream,
  type ServerRunEventStream,
} from './serverRunFetchEventStream';
import {
  loadServerRunMetadata,
  recoveredServerRunTerminal,
  type ServerRunOptions,
} from './serverRunProtocol';
import {
  finishRecoveredRun,
  isPermanentServerRunRecoveryError,
  permanentServerRunRecoveryError,
} from './serverRunRecovery';
import {
  clearStoredServerRunLease,
  clearStoredServerRun,
  patchStoredServerRun,
  readStoredServerRun,
} from './serverRunSessionStorage';
import { settleAbandonedServerRun } from './serverRunAbandon';
import { releaseServerRunOwnership } from './serverRunOwnership';
import type { ServerRunState } from './serverRunState';

export interface ServerRunStreamLifecycle {
  readonly subscribe: (runId: string) => void;
  readonly finishRun: (
    runId: string,
    status: 'awaiting_user' | 'completed' | 'failed' | 'cancelled',
  ) => Promise<void>;
  readonly scheduleRecovery: (runId: string) => void;
  readonly abandonStaleRecovery: (runId: string, error: unknown) => void;
}

interface ServerRunStreamHandlers {
  readonly finishRun: ServerRunStreamLifecycle['finishRun'];
  readonly scheduleRecovery: ServerRunStreamLifecycle['scheduleRecovery'];
  readonly abandonStaleRecovery: ServerRunStreamLifecycle['abandonStaleRecovery'];
}

function currentOptions(state: ServerRunState): ServerRunOptions {
  return state.refs.activeOptions.current ?? state.refs.options.current;
}

function resetAbandonedRun(state: ServerRunState): void {
  const { refs } = state;
  refs.runId.current = null;
  refs.capability.current = null;
  refs.runProject.current = null;
  refs.abort.current = null;
  refs.cursor.current = 0;
  refs.assistantText.current = '';
  refs.assistantThinking.current = '';
  refs.finalizingRun.current = null;
  refs.activeOptions.current = null;
  refs.runExecutor.current = null;
  state.eventSession.resetRecovery();
}

async function settleStaleRecovery(
  projectId: string,
  runId: string,
  detail: string,
  state: ServerRunState,
): Promise<void> {
  try {
    const transportWarning = await settleAbandonedServerRun({
      projectId,
      runId,
      capability: state.refs.capability.current,
      summary: detail || 'Server run recovery became unavailable.',
    });
    await currentOptions(state).onRunAbandon?.(runId);
    clearStoredServerRun(projectId, runId);
    releaseServerRunOwnership(projectId, runId);
    resetAbandonedRun(state);
    state.appendMessage({
      role: 'error',
      text: `之前的服务端任务已安全中断并清除恢复状态。${detail
        ? ` ${detail}` : ''}${transportWarning ? ` 传输清理警告：${transportWarning}` : ''}`,
    });
  } catch (error) {
    state.refs.staleRecoveryRun.current = null;
    state.appendMessage({
      role: 'error',
      text: `服务端任务无法安全恢复，恢复凭据已保留：${error instanceof Error
        ? error.message : String(error)}`,
    });
  } finally {
    state.refs.running.current = false;
    state.setRunning(false);
  }
}

function resetFinishedRun(
  projectId: string,
  state: ServerRunState,
  runId: string,
): void {
  const { refs } = state;
  releaseServerRunOwnership(projectId, runId);
  refs.terminalRun.current = runId;
  refs.runId.current = null;
  refs.capability.current = null;
  refs.runProject.current = null;
  refs.running.current = false;
  refs.abort.current = null;
  refs.activeOptions.current = null;
  refs.runExecutor.current = null;
  state.setRunning(false);
  state.eventSession.resetRecovery();
}

function commitSequence(
  projectId: string,
  state: ServerRunState,
  event: Event,
): ServerRunEventCommit {
  const sequence = Number((event as MessageEvent).lastEventId);
  if (!Number.isSafeInteger(sequence) || sequence <= state.refs.cursor.current) return 'ignored';
  if (!patchStoredServerRun(projectId, { cursor: sequence })) return 'failed';
  state.refs.cursor.current = sequence;
  return 'committed';
}

function commitTextDelta(
  projectId: string,
  state: ServerRunState,
  event: Event,
  delta: string,
): ServerRunEventCommit {
  const sequence = Number((event as MessageEvent).lastEventId);
  if (!Number.isSafeInteger(sequence) || sequence <= state.refs.cursor.current) return 'ignored';
  const assistantText = state.refs.assistantText.current + delta;
  if (!patchStoredServerRun(projectId, { cursor: sequence, assistantText })) return 'failed';
  state.refs.cursor.current = sequence;
  state.appendStreamingText(delta);
  return 'committed';
}
function commitThinkingDelta(
  projectId: string,
  state: ServerRunState,
  event: Event,
  delta: string,
): ServerRunEventCommit {
  const sequence = Number((event as MessageEvent).lastEventId);
  if (!Number.isSafeInteger(sequence) || sequence <= state.refs.cursor.current) return 'ignored';
  const assistantThinking = state.refs.assistantThinking.current + delta;
  if (!patchStoredServerRun(projectId, { cursor: sequence, assistantThinking })) return 'failed';
  state.refs.cursor.current = sequence;
  state.appendStreamingThinking(delta);
  return 'committed';
}

function bindEventSource(
  projectId: string,
  runId: string,
  state: ServerRunState,
  lifecycle: ServerRunStreamHandlers,
  source: ServerRunEventStream,
): void {
  bindServerRunEvents(source, runId, {
    enabled: () => state.refs.enabled.current,
    ready: () => state.refs.ready.current,
    commit: (event) => commitSequence(projectId, state, event),
    commitTextDelta: (event, delta) => commitTextDelta(projectId, state, event, delta),
    commitThinkingDelta: (event, delta) => commitThinkingDelta(projectId, state, event, delta),
    ensureAssistantMessage: () => state.updateMessages((current) => (
      current.at(-1)?.role === 'assistant'
        ? current
        : [...current, { role: 'assistant', text: '' }]
    )),
    handleToolRequest: (id, callId, name, args, digest, admit) => (
      state.toolExecutor.handle(id, callId, name, args, digest, admit)
    ),
    retry: (id) => state.eventSession.retry(id),
    finish: (id, status) => { void lifecycle.finishRun(id, status); },
    appendMessage: state.appendMessage,
    onContextUsage: (usage) => { state.setContextUsage(usage); },
    transportError: (eventSource, id) => {
      state.eventSession.handleTransportError(eventSource, id);
    },
    persistenceError: (id) => {
      lifecycle.abandonStaleRecovery(id, permanentServerRunRecoveryError(
        'Browser durable storage could not persist server run progress.',
      ));
    },
    opened: () => { state.eventSession.markOpened(source); },
  });
}

async function openSubscription(
  projectId: string,
  runId: string,
  capability: string,
  epoch: number,
  state: ServerRunState,
  lifecycle: ServerRunStreamHandlers,
): Promise<void> {
  const metadata = await loadServerRunMetadata(projectId, runId, capability);
  if (!state.eventSession.isCurrent(epoch)
    || !state.refs.enabled.current || !state.refs.ready.current) return;
  const cursor = state.refs.cursor.current;
  if (typeof metadata.firstEventId === 'number' && cursor < metadata.firstEventId - 1) {
    throw permanentServerRunRecoveryError('服务端任务事件已超出可恢复窗口。');
  }
  const terminalStatus = recoveredServerRunTerminal(metadata, cursor);
  if (terminalStatus) {
    await lifecycle.finishRun(runId, terminalStatus);
    return;
  }
  const source = openServerRunEventStream({ projectId, runId, capability, after: cursor });
  if (!state.eventSession.attach(source, epoch)) return;
  bindEventSource(projectId, runId, state, lifecycle, source);
}

function handleSubscriptionError(
  runId: string,
  epoch: number,
  error: unknown,
  state: ServerRunState,
  lifecycle: ServerRunStreamHandlers,
): void {
  if (!state.eventSession.isCurrent(epoch)) return;
  if (isPermanentServerRunRecoveryError(error)) {
    lifecycle.abandonStaleRecovery(runId, error);
  } else {
    lifecycle.scheduleRecovery(runId);
  }
}

function useAbandonStaleRecovery(
  projectId: string,
  state: ServerRunState,
): ServerRunStreamLifecycle['abandonStaleRecovery'] {
  const stateRef = useRef(state);
  stateRef.current = state;
  return useCallback((runId: string, error: unknown) => {
    const current = stateRef.current;
    if (current.refs.staleRecoveryRun.current === runId) return;
    current.refs.staleRecoveryRun.current = runId;
    current.eventSession.close();
    current.refs.runExecutor.current?.stop();
    const detail = error instanceof Error ? error.message : String(error);
    void settleStaleRecovery(projectId, runId, detail, current);
  }, [projectId]);
}

function useFinishRun(
  projectId: string,
  state: ServerRunState,
  scheduleRecovery: ServerRunStreamLifecycle['scheduleRecovery'],
  abandonStaleRecovery: ServerRunStreamLifecycle['abandonStaleRecovery'],
): ServerRunStreamLifecycle['finishRun'] {
  const stateRef = useRef(state);
  stateRef.current = state;
  return useCallback(async (runId, status) => {
    const current = stateRef.current;
    if (current.refs.terminalRun.current === runId
      || current.refs.finalizingRun.current === runId) return;
    current.refs.finalizingRun.current = runId;
    current.eventSession.close();
    current.refs.runExecutor.current?.stop();
    const leaseToken = readStoredServerRun(projectId)?.leaseToken;
    try {
      const disposition = await finishRecoveredRun({
        projectId,
        runId,
        status,
        assistantText: current.refs.assistantText.current,
        commitModelTurn: currentOptions(current).session?.commitModelTurn,
        onTerminal: currentOptions(current).onTerminal,
      });
      if (!disposition) return scheduleRecovery(runId);
      await currentOptions(current).onRunAbandon?.(runId);
      if (disposition === 'waiting_approval' && leaseToken) {
        clearStoredServerRunLease(projectId, runId, leaseToken);
      }
      resetFinishedRun(projectId, current, runId);
    } catch (error) {
      if (isPermanentServerRunRecoveryError(error)) abandonStaleRecovery(runId, error);
      else scheduleRecovery(runId);
    } finally {
      current.refs.finalizingRun.current = null;
    }
  }, [abandonStaleRecovery, projectId, scheduleRecovery]);
}

function useSubscribe(
  projectId: string,
  state: ServerRunState,
  lifecycle: ServerRunStreamHandlers,
): ServerRunStreamLifecycle['subscribe'] {
  const stateRef = useRef(state);
  const lifecycleRef = useRef(lifecycle);
  stateRef.current = state;
  lifecycleRef.current = lifecycle;
  return useCallback((runId: string) => {
    const current = stateRef.current;
    const handlers = lifecycleRef.current;
    if (!current.refs.enabled.current) return;
    if (!current.refs.ready.current) return current.eventSession.scheduleReconnect(runId);
    const capability = current.refs.capability.current;
    if (!capability) {
      handlers.abandonStaleRecovery(runId, permanentServerRunRecoveryError(
        'Stored server run capability is unavailable.',
      ));
      return;
    }
    const epoch = current.eventSession.beginConnection();
    void openSubscription(projectId, runId, capability, epoch, current, handlers)
      .catch((error: unknown) => {
        handleSubscriptionError(runId, epoch, error, current, handlers);
      });
  }, [projectId]);
}

export function useServerRunStreamLifecycle(
  projectId: string,
  state: ServerRunState,
): ServerRunStreamLifecycle {
  const scheduleRecovery = useCallback((runId: string) => {
    state.eventSession.scheduleReconnect(runId);
  }, [state.eventSession]);
  const abandonStaleRecovery = useAbandonStaleRecovery(projectId, state);
  const finishRun = useFinishRun(
    projectId,
    state,
    scheduleRecovery,
    abandonStaleRecovery,
  );
  const lifecycle = { finishRun, scheduleRecovery, abandonStaleRecovery };
  const subscribe = useSubscribe(projectId, state, lifecycle);
  state.refs.subscribe.current = subscribe;
  state.refs.abandonRecovery.current = abandonStaleRecovery;
  return { subscribe, ...lifecycle };
}
