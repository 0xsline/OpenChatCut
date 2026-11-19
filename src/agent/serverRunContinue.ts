import { resolveAgentReferences } from './context';
import type { AgentSendOptions } from './useAgentRun';
import type { ServerRunSendEnvironment } from './serverRunSend';
import {
  loadServerRunMetadata, restoreServerRunToolActivation, SERVER_RUN_CAPABILITY_HEADER,
  type ServerRunMetadata,
} from './serverRunProtocol';
import {
  patchStoredServerRun, readStoredServerRun,
  type StoredContinuation, type StoredServerRun,
} from './serverRunSessionStorage';
import { reconcileRunEvidence, submitExistingRunOutcomes } from './serverRunToolReconcileClient';
import { acquireServerRunOwnership, releaseServerRunOwnership } from './serverRunOwnership';
import { recoveredToolMap } from './serverRunRecovery';
import { restoreContinuationMessages, PAUSED_RUN_NOTICE } from './serverRunPause';

export function acknowledgeContinuation(projectId: string, metadata: ServerRunMetadata): boolean {
  const stored = readStoredServerRun(projectId);
  if (!stored?.pendingContinuation || metadata.recovery?.lastContinuationId !== stored.pendingContinuation.id) return false;
  if (!patchStoredServerRun(projectId, { pendingContinuation: undefined,
    paused: metadata.status === 'paused' || metadata.recovery.state === 'paused' })) {
    throw new Error('Browser durable storage could not acknowledge continuation.');
  }
  return true;
}

function prepareContinuation(environment: ServerRunSendEnvironment, stored: StoredServerRun,
  text: string, options: AgentSendOptions): StoredContinuation {
  if (stored.pendingContinuation) {
    if (stored.pendingContinuation.text !== text) throw new Error('上一条继续指令尚未确认，请重发该指令，或刷新核对后再发送新消息。');
    return stored.pendingContinuation;
  }
  const entries = resolveAgentReferences(environment.refs.context.current, options.references ?? []);
  const message = entries.length ? `${text}\n\n${JSON.stringify({ type: 'chat_context_entry', entries })}` : text;
  const pending = { id: crypto.randomUUID(), text, message,
    previousAssistantText: stored.assistantText ?? '' };
  if (!patchStoredServerRun(environment.projectId, {
    pendingContinuation: pending,
    continuationTurns: [...(stored.continuationTurns ?? []), pending],
    content: `${stored.content ?? stored.text ?? ''}\n\n${message}`,
    assistantText: '', assistantThinking: '',
  })) throw new Error('Browser durable storage could not persist continuation.');
  return pending;
}

async function postContinuation(environment: ServerRunSendEnvironment, stored: StoredServerRun,
  pending: StoredContinuation, metadata: ServerRunMetadata): Promise<void> {
  const response = await fetch(`/api/agent-runs/${encodeURIComponent(stored.runId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SERVER_RUN_CAPABILITY_HEADER]: stored.capability! },
    body: JSON.stringify({ projectId: environment.projectId, mode: 'continue',
      expectedRevision: metadata.recovery!.revision,
      continuationId: pending.id, message: pending.message }),
  });
  if (response.status !== 202 && response.status !== 200) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(`继续任务尚未获准：${body.error ?? `HTTP ${response.status}`}`);
  }
  const body = await response.json() as { continuationId?: string };
  if (readStoredServerRun(environment.projectId)?.runId !== stored.runId) return;
  if (body.continuationId !== pending.id) throw new Error('Server continuation identity did not match.');
  if (!patchStoredServerRun(environment.projectId, { paused: false, pendingContinuation: undefined })) {
    throw new Error('Browser durable storage could not acknowledge continuation.');
  }
}

function retainUnsentInstruction(environment: ServerRunSendEnvironment, text: string, reason: string): void {
  environment.appendMessage({ role: 'note',
    text: `${reason}\n本次消息尚未发送，已保留原文，可复制并在恢复后重新发送：\n${text}` });
}

/** Returns true whenever the old run owns this send, including unresolved evidence. */
export async function continuePausedServerRun(environment: ServerRunSendEnvironment,
  text: string, options: AgentSendOptions): Promise<boolean> {
  let stored = readStoredServerRun(environment.projectId);
  if (!stored) return false;
  if (environment.refs.running.current) return true;
  const { refs, projectId } = environment;
  if (!refs.enabled.current || !refs.ready.current || !text.trim()) return true;
  // Fence double Enter before the first metadata read, not after its await.
  refs.running.current = true;
  let owned = false;
  let started = false;
  try {
    let metadata = await loadServerRunMetadata(projectId, stored.runId, stored.capability!);
    const paused = metadata.status === 'paused' || metadata.recovery?.state === 'paused';
    let pendingAccepted = acknowledgeContinuation(projectId, metadata);
    if (pendingAccepted && paused) {
      // The accepted attempt already paused again; this instruction starts the next attempt.
      stored = readStoredServerRun(projectId)!;
      pendingAccepted = false;
    } else if (pendingAccepted && stored.pendingContinuation?.text !== text.trim()) {
      retainUnsentInstruction(environment, text, '上一条继续指令已确认，正在恢复任务。');
      environment.scheduleRecovery(stored.runId);
      return true;
    }
    if (!paused && !stored.pendingContinuation) {
      refs.running.current = false;
      if (stored.paused || (metadata.recovery && metadata.recovery.state !== 'finalized')) {
        patchStoredServerRun(projectId, { paused: false });
        retainUnsentInstruction(environment, text, '正在核对并恢复上次任务的状态。');
        environment.scheduleRecovery(stored.runId);
        return true;
      }
      return false;
    }
    owned = await acquireServerRunOwnership(projectId, stored.runId);
    if (!owned) throw new Error('服务端任务已由另一个页面接管，本页不会重复执行。');
    refs.runId.current = stored.runId;
    refs.runProject.current = projectId;
    refs.capability.current = stored.capability ?? null;
    const active = () => readStoredServerRun(projectId)?.runId === stored!.runId
      && refs.runId.current === stored!.runId && refs.enabled.current;
    let evidence = await reconcileRunEvidence(projectId, stored.runId, stored.capability, refs.context.current.getDoc());
    if (evidence.blocked) throw new Error(evidence.summary);
    if (evidence.existingOutcomes.length) {
      await submitExistingRunOutcomes(projectId, stored.runId, stored.capability!, evidence, active);
      evidence = await reconcileRunEvidence(projectId, stored.runId, stored.capability, refs.context.current.getDoc());
    }
    if (!active()) return true;
    if (evidence.blocked) throw new Error(evidence.summary);
    metadata = evidence.metadata;
    const recovery = await refs.options.current.onRunStart?.({ runId: stored.runId,
      text: stored.text ?? '', content: stored.content ?? '', askOnly: stored.askOnly === true,
      references: stored.references ?? [], baseDoc: refs.context.current.getDoc(), resumed: true,
      durableTools: metadata.recovery?.tools ?? [] });
    if (!active()) return true;
    if (recovery?.blocked) throw new Error('上次编辑仍无法核对，请重新核对或结束任务。');
    const activation = restoreServerRunToolActivation(stored.askOnly === true, stored.activeToolNames);
    if (!activation) throw new Error('Stored server run has an invalid active tool set.');
    const accepted = pendingAccepted || acknowledgeContinuation(projectId, metadata);
    const pending = accepted ? null : prepareContinuation(environment, stored, text.trim(), options);
    stored = readStoredServerRun(projectId)!;
    environment.updateMessages((messages) => restoreContinuationMessages(messages.filter((message) => !message.paused), stored!));
    refs.assistantText.current = stored.assistantText ?? '';
    refs.assistantThinking.current = stored.assistantThinking ?? '';
    refs.cursor.current = stored.cursor ?? 0;
    refs.abort.current = new AbortController();
    environment.toolExecutor.start({ capability: stored.capability!, runId: stored.runId,
      baseDoc: recovery?.baseDoc ?? refs.context.current.getDoc(), draftDoc: recovery?.draftDoc,
      activation, abort: refs.abort.current, recovered: recoveredToolMap(recovery?.tools ?? []) });
    environment.setRunning(true);
    if (pending) {
      try { await postContinuation(environment, stored, pending, metadata); }
      catch (error) {
        const latest = await loadServerRunMetadata(projectId, stored.runId, stored.capability!).catch(() => null);
        if (!latest || !acknowledgeContinuation(projectId, latest)) throw error;
      }
    }
    if (!active()) return true;
    started = true;
    environment.subscribe(stored.runId);
    return true;
  } catch (error) {
    if (readStoredServerRun(projectId)?.runId !== stored.runId) return true;
    environment.toolExecutor.stop();
    if (readStoredServerRun(projectId)?.runId === stored.runId) patchStoredServerRun(projectId, { paused: true });
    environment.appendMessage({ role: 'error', paused: true,
      text: `${error instanceof Error ? error.message : String(error)}\n${PAUSED_RUN_NOTICE}` });
    return true;
  } finally {
    if (!started) {
      refs.running.current = false;
      environment.setRunning(false);
      if (owned) releaseServerRunOwnership(projectId, stored.runId);
    }
  }
}
