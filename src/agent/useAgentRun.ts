import { useCallback, useRef } from 'react';
import type { ProjectDoc } from '../editor/types';
import { makeDraft, replayActions, type DraftEngine } from '../editor/store';
import { saveAutomaticVersion } from '../persist/versionStore';
import { saveProject } from '../persist/projectStore';
import { clearProposal, saveProposal, settleProposal } from '../persist/proposalStore';
import { resolveAgentReferences, type AgentContext } from './context';
import { prepareMessagesForProvider } from './messages';
import { PROVIDER } from './providerConfig';
import { getAgentModelSnapshot, isAgentModelReady } from './model-selection';
import { createAgentRetry, preloadAgentRuntime, enhanceAgentPrompt, type AgentRetryOptions, type PendingGuard } from './agent-session';
import {
  buildOperation,
  buildProposal,
  partitionProposalActions,
  type Operation,
  type Proposal,
} from './proposal';
import { appendAgentChange, createAgentChangeSession } from './changeLog';
import { isCostAllowed, rememberCostAllowed, type GuardDecision } from './skills/costGuard';
import { agentAutoApply } from './approval-mode';
import type { RuntimeGuardRequest } from './runtime-guard';
import type { AgentEvent } from './runtime';
import { startAgentRun, type AgentRunRecorder } from './runtime-ledger';
import type { AgentRunStatus } from '../persist/agentRuntimeStore';
import { isFailedToolResult } from './toolFailure';
import type { AgentHookState } from './useAgentState';

export type AgentSendOptions = AgentRetryOptions;
export type AgentSend = (text: string, opts?: AgentSendOptions) => Promise<void>;

export interface AgentTurn {
  state: AgentHookState;
  projectId: string;
  trimmed: string;
  retryOptions: AgentRetryOptions;
  askOnly: boolean;
  baseDoc: ProjectDoc;
  proposalBaseDoc: ProjectDoc;
  draft: DraftEngine;
  draftCtx: AgentContext;
  ops: Operation[];
  persistentOps: Operation[];
  persistentBeforeDoc: ProjectDoc | null;
  persistentSnapshot: Promise<void>;
  persistentSaveError: unknown;
  draftInvalidated: boolean;
  assistantText: string;
  completionStatus: AgentRunStatus;
  runtimeErrorShown: boolean;
  toolCallCount: number;
  recorder: AgentRunRecorder | null;
  abortController: AbortController;
}

export function draftContext(ctx: AgentContext, draft: DraftEngine): AgentContext {
  return {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: ctx.getCreativeMode,
    setCreativeMode: ctx.setCreativeMode,
    templates: ctx.templates,
    audio: ctx.audio,
    getProjectId: ctx.getProjectId,
    openProject: ctx.openProject,
    onProjectRenamed: ctx.onProjectRenamed,
    getUndoTarget: ctx.getUndoTarget,
    getRedoTarget: ctx.getRedoTarget,
  };
}

function preparePrompt(state: AgentHookState, text: string, options?: AgentSendOptions): void {
  const entries = resolveAgentReferences(state.ctxRef.current, options?.references ?? []);
  const content = entries.length
    ? `${text}\n\n${JSON.stringify({ type: 'chat_context_entry', entries })}`
    : text;
  if (state.llmProviderRef.current !== PROVIDER) {
    state.llmRef.current = prepareMessagesForProvider(
      state.llmRef.current,
      state.llmProviderRef.current,
      PROVIDER,
    );
    state.llmProviderRef.current = PROVIDER;
  }
  state.llmRef.current.push({ role: 'user', content });
  state.refreshEstimatedContextUsage();
}

function beginTurn(
  state: AgentHookState,
  projectId: string,
  text: string,
  options?: AgentSendOptions,
): AgentTurn | null {
  const trimmed = text.trim();
  if (!trimmed || state.runningRef.current || state.proposalRef.current) return null;
  if (!isAgentModelReady(getAgentModelSnapshot())) return null;
  state.setMessages((messages) => [...messages, { role: 'user', text: trimmed, retry: createAgentRetry(trimmed, { askOnly: options?.askOnly, references: options?.references }) }]);
  preparePrompt(state, trimmed, options);
  state.setRunning(true);
  state.runningRef.current = true;
  const baseDoc = state.ctxRef.current.getDoc();
  const draft = makeDraft(baseDoc);
  const abortController = new AbortController();
  state.abortRef.current = abortController;
  return {
    state, projectId, trimmed,
    retryOptions: { askOnly: options?.askOnly, references: options?.references },
    askOnly: options?.askOnly === true, baseDoc,
    proposalBaseDoc: baseDoc, draft, draftCtx: draftContext(state.ctxRef.current, draft),
    ops: [], persistentOps: [], persistentBeforeDoc: null,
    persistentSnapshot: Promise.resolve(), persistentSaveError: undefined,
    draftInvalidated: false, assistantText: '', completionStatus: 'completed',
    runtimeErrorShown: false, toolCallCount: 0, recorder: null, abortController,
  };
}

type AgentTextEvent = Extract<AgentEvent, {
  type: 'text-start' | 'thinking-delta' | 'text-delta';
}>;

function isTextEvent(event: AgentEvent): event is AgentTextEvent {
  return event.type === 'text-start'
    || event.type === 'thinking-delta'
    || event.type === 'text-delta';
}

function handleTextEvent(turn: AgentTurn, event: AgentTextEvent): void {
  const { setMessages } = turn.state;
  if (event.type === 'text-start') {
    setMessages((messages) => {
      const last = messages[messages.length - 1];
      return last?.role === 'assistant' && last.text === '' && last.thinking
        ? messages : [...messages, { role: 'assistant', text: '' }];
    });
  } else if (event.type === 'thinking-delta') {
    setMessages((messages) => {
      const last = messages[messages.length - 1];
      return last?.role === 'assistant'
        ? [...messages.slice(0, -1), { ...last, thinking: (last.thinking ?? '') + event.delta }]
        : [...messages, { role: 'assistant', text: '', thinking: event.delta }];
    });
  } else if (event.type === 'text-delta') {
    turn.assistantText += event.delta;
    setMessages((messages) => {
      const last = messages[messages.length - 1];
      return last?.role === 'assistant'
        ? [...messages.slice(0, -1), { ...last, text: last.text + event.delta }]
        : [...messages, { role: 'assistant', text: event.delta }];
    });
  }
}


function capturePersistentBase(turn: AgentTurn): void {
  const observed = turn.state.ctxRef.current.getDoc();
  if (!turn.persistentBeforeDoc) {
    turn.persistentBeforeDoc = observed;
    turn.persistentSnapshot = saveAutomaticVersion(turn.projectId, 'Agent 修改前', observed).then(
      () => undefined,
      (error) => { turn.persistentSaveError = error; },
    );
    if (observed !== turn.baseDoc) turn.draftInvalidated = true;
  } else if (observed !== turn.persistentBeforeDoc) {
    turn.draftInvalidated = true;
  }
}

function handleToolEvent(turn: AgentTurn, event: Extract<AgentEvent, { type: 'tool' }>): void {
  turn.state.setLiveTool(null);
  turn.state.setMessages((messages) => [...messages, {
    role: 'tool', text: '', tool: { name: event.name, args: event.args, result: event.result },
  }]);
  const actions = turn.draft.takeActions();
  if (isFailedToolResult(event.result)) return;
  const { persistent, proposed } = partitionProposalActions(actions);
  const args = event.args as Record<string, unknown>;
  if (persistent.length) {
    capturePersistentBase(turn);
    turn.proposalBaseDoc = replayActions(turn.proposalBaseDoc, persistent);
    turn.persistentOps.push(buildOperation(event.name, args, persistent));
  }
  if (proposed.length) turn.ops.push(buildOperation(event.name, args, proposed));
}
export function statusAfterMaxToolTurns(status: AgentRunStatus): AgentRunStatus {
  return status === 'awaiting_user' ? 'completed' : status;
}


function handleAgentEvent(turn: AgentTurn, event: AgentEvent): void {
  if (isTextEvent(event)) {
    handleTextEvent(turn, event);
    return;
  }
  if (event.type === 'tool-input-start') {
    turn.toolCallCount += 1;
    turn.state.setLiveTool({ name: event.name, partial: '' });
  } else if (event.type === 'tool-input-delta') {
    turn.state.setLiveTool((tool) => tool ? { ...tool, partial: tool.partial + event.delta } : tool);
  } else if (event.type === 'tool') handleToolEvent(turn, event);
  else if (event.type === 'max-turns') {
    turn.completionStatus = statusAfterMaxToolTurns(turn.completionStatus);
    turn.state.setMessages((messages) => [...messages, { role: 'continue', text: String(event.turns) }]);
  } else if (event.type === 'context-usage') turn.state.replaceContextUsage(event.usage);
  else {
    turn.completionStatus = 'failed';
    turn.runtimeErrorShown = true;
    turn.state.setMessages((messages) => [...messages, {
      role: 'error', text: event.message,
    }]);
  }
}

export function requestRuntimeGuard(
  state: AgentHookState,
  projectId: string,
  guard: RuntimeGuardRequest,
): Promise<GuardDecision> {
  // YOLO (auto-apply) mode releases every confirmation card: the user opted
  // into unapproved execution (sessionPrefs documents the intent). Paid,
  // persistent-local and irreversible operations all run without a prompt.
  if (agentAutoApply()) return Promise.resolve('allow-once');
  const rememberable = guard.approval === 'project' && guard.permissionKind === 'paid_external';
  if (rememberable && isCostAllowed(guard.skill, projectId)) return Promise.resolve('allow-once');
  const { promise, resolve } = Promise.withResolvers<GuardDecision>();
  let pending: PendingGuard;
  pending = {
    ...guard,
    resolve: (requested) => {
      if (state.pendingGuardRef.current === pending) {
        state.pendingGuardRef.current = null;
        state.setPendingGuard(null);
      }
      const decision = requested === 'allow-scope' && !rememberable ? 'allow-once' : requested;
      if (decision === 'allow-scope') rememberCostAllowed(guard.skill, projectId);
      resolve(decision);
    },
  };
  state.pendingGuardRef.current = pending;
  state.setPendingGuard(pending);
  return promise;
}

async function runRuntime(turn: AgentTurn): Promise<void> {
  const recorder = await startAgentRun({
    projectId: turn.projectId,
    userInput: turn.trimmed,
    askOnly: turn.askOnly,
  });
  turn.recorder = recorder;
  const { runAgent } = await preloadAgentRuntime();
  turn.state.llmRef.current = await runAgent(
    turn.state.llmRef.current,
    turn.draftCtx,
    (event) => handleAgentEvent(turn, event),
    {
      askOnly: turn.askOnly,
      signal: turn.abortController.signal,
      previousContextUsage: turn.state.contextUsageRef.current ?? undefined,
      toolFailures: turn.state.toolFailuresRef.current,
      runRecorder: recorder,
      onSkillGuard: (guard) => requestRuntimeGuard(turn.state, turn.projectId, guard),
    },
  );
}

function showRunError(turn: AgentTurn, text: string): void {
  turn.completionStatus = 'failed';
  turn.state.setMessages((messages) => [...messages, { role: 'error', text }]);
}


async function restoreUncommittedSave(
  turn: AgentTurn,
  expectedDoc: ProjectDoc,
  persist: typeof saveProject,
): Promise<boolean> {
  const latestDoc = turn.state.ctxRef.current.getDoc();
  if (!turn.abortController.signal.aborted && latestDoc === expectedDoc) return false;
  const restored = await persist(turn.projectId, latestDoc).catch(() => null);
  if (!restored?.saved) {
    showRunError(turn, 'Agent 已停止，但无法恢复工程存储。请重新打开工程并检查内容。');
  } else if (!turn.abortController.signal.aborted) {
    showRunError(turn, '保存期间工程发生了其他修改；Agent 改动未应用，请重新发送请求。');
  }
  return true;
}
export async function commitPersistentOperations(
  turn: AgentTurn,
  persist: typeof saveProject = saveProject,
): Promise<boolean> {
  if (turn.abortController.signal.aborted) return false;
  await turn.persistentSnapshot;
  if (turn.abortController.signal.aborted) return false;
  if (turn.persistentSaveError) {
    showRunError(turn, '无法创建修改前版本，Agent 改动未应用。请检查本地存储后重试。');
    return false;
  }
  turn.state.llmProviderRef.current = PROVIDER;
  if (!turn.persistentBeforeDoc || !turn.persistentOps.length) return true;
  const currentDoc = turn.state.ctxRef.current.getDoc();
  if (turn.draftInvalidated || currentDoc !== turn.persistentBeforeDoc) {
    showRunError(turn, '生成期间工程发生了其他修改；Agent 改动未应用，请重新发送请求。');
    return false;
  }
  const actions = turn.persistentOps.flatMap((operation) => operation.actions);
  const afterDoc = replayActions(currentDoc, actions);
  if (turn.abortController.signal.aborted) return false;
  const saved = await persist(turn.projectId, afterDoc).catch(() => null);
  if (!saved?.saved) {
    showRunError(turn, '无法保存工程，Agent 改动未应用。请检查本地存储后重试。');
    return false;
  }
  if (await restoreUncommittedSave(turn, currentDoc, persist)) return false;
  if (turn.abortController.signal.aborted) return false;
  turn.state.ctxRef.current.commands.applyDoc(afterDoc);
  const session = createAgentChangeSession(
    turn.assistantText, turn.persistentOps, turn.persistentBeforeDoc, afterDoc, true,
  );
  turn.state.setChangeLog((current) => appendAgentChange(current, session));
  return true;
}

async function discardUnexposedProposal(projectId: string, proposal: Proposal): Promise<void> {
  await settleProposal(projectId, proposal, 'stale');
  await clearProposal(projectId, proposal.id);
}
export function exposePendingProposal(turn: AgentTurn, proposal: Proposal): void {
  turn.completionStatus = 'waiting_approval';
  turn.state.setProposalStale(false);
  turn.state.setProposal(proposal);
}


export async function createPendingProposal(
  turn: AgentTurn,
  persist: typeof saveProposal = saveProposal,
  expose = true,
): Promise<Proposal | null> {
  if (turn.abortController.signal.aborted || turn.completionStatus === 'failed' || !turn.ops.length) {
    return null;
  }
  if (turn.draftInvalidated) {
    showRunError(turn, '生成期间工程发生了其他修改；素材已保存到媒体池，请重新发送落轨请求。');
    return null;
  }
  if (!turn.recorder) return null;
  const proposal = buildProposal(
    turn.ops, turn.assistantText, turn.proposalBaseDoc, turn.draft.getState(), turn.recorder.runId,
  );
  await persist(turn.projectId, proposal);
  if (turn.abortController.signal.aborted) {
    await discardUnexposedProposal(turn.projectId, proposal);
    return null;
  }
  try {
    await turn.recorder.recordProposal(proposal.id, 'created');
  } catch (error) {
    await discardUnexposedProposal(turn.projectId, proposal);
    throw error;
  }
  if (turn.abortController.signal.aborted) {
    await discardUnexposedProposal(turn.projectId, proposal);
    return null;
  }
  if (expose) exposePendingProposal(turn, proposal);
  return proposal;
}

function handleRuntimeFailure(turn: AgentTurn, error: unknown): void {
  turn.completionStatus = turn.abortController.signal.aborted ? 'aborted' : 'failed';
  if (turn.abortController.signal.aborted || turn.runtimeErrorShown) return;
  turn.state.setMessages((messages) => [...messages, {
    role: 'error',
    text: error instanceof Error ? error.message : String(error),
  }]);
}

async function finalizeTurn(turn: AgentTurn): Promise<void> {
  if (turn.abortController.signal.aborted) turn.completionStatus = 'aborted';
  await turn.recorder?.finalize(turn.completionStatus, turn.assistantText || turn.completionStatus)
    .catch(() => undefined);
  turn.state.abortRef.current = null;
  turn.state.setLiveTool(null);
  turn.state.runningRef.current = false;
  turn.state.setRunning(false);
}

async function executeTurn(turn: AgentTurn): Promise<void> {
  try {
    if (turn.abortController.signal.aborted) return;
    await runRuntime(turn);
    if (turn.abortController.signal.aborted) return;
    const committed = await commitPersistentOperations(turn);
    if (turn.abortController.signal.aborted || !committed) return;
    await createPendingProposal(turn);
    if (turn.abortController.signal.aborted) turn.completionStatus = 'aborted';
  } catch (error) {
    handleRuntimeFailure(turn, error);
  } finally {
    await finalizeTurn(turn);
  }
}

export function useAgentRun(state: AgentHookState, projectId: string) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const send = useCallback<AgentSend>(async (text, options) => {
    const turn = beginTurn(stateRef.current, projectId, text, options);
    if (turn) await executeTurn(turn);
  }, [projectId]);
  const stop = useCallback(() => {
    stateRef.current.pendingGuardRef.current?.resolve('deny');
    stateRef.current.toolFailuresRef.current.clear();
    stateRef.current.abortRef.current?.abort();
  }, []);
  const enhance = useCallback(enhanceAgentPrompt, []);
  return { send, stop, enhance };
}
