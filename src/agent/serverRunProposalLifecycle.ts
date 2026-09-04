import { useCallback, useRef } from 'react';
import { makeDraft, replayActions } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { saveAutomaticVersion } from '../persist/versionStore';
import type { AgentContext } from './context';
import {
  buildOperation,
  partitionProposalActions,
  projectDocsDiffer,
} from './proposal';
import {
  commitPersistentOperations,
  createPendingProposal,
  discardUnexposedProposal,
  exposePendingProposal,
  type AgentTurn,
} from './useAgentRun';
import { settleServerRun } from './serverRunSettleClient';
import type { AgentHookState, MutableValue } from './useAgentState';
import { isFailedToolResult } from './toolFailure';
import {
  clearServerRunDraft,
  loadServerRunDraft,
  saveServerRunDraftBase,
  saveServerRunDraftTool,
  type ServerRunDraftToolBody,
} from './serverRunDraftStore';
import { ServerRunTerminalHandoffs } from './serverRunTerminalHandoff';
import { permanentServerRunRecoveryError } from './serverRunRecovery';
import type {
  ServerRunPreparation,
  ServerRunRecovery,
  ServerRunStart,
  ServerRunTerminal,
  ServerRunTerminalResolution,
  ServerRunToolAction,
} from './serverRunProtocol';

interface ProposalRunState {
  turn: AgentTurn | null;
  seenToolCalls: Set<string>;
  handoffs: ServerRunTerminalHandoffs;
}

type ProposalRunRef = MutableValue<ProposalRunState>;
export function serverRunDraftBaseChanged(
  baseDoc: ProjectDoc,
  currentDoc: ProjectDoc,
): boolean {
  return projectDocsDiffer(baseDoc, currentDoc);
}


function turnContext(ctx: AgentContext, doc: ProjectDoc) {
  const draft = makeDraft(doc);
  return {
    draft,
    draftCtx: {
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
      getApprovalMode: ctx.getApprovalMode,
      getOfflineMediaSrcs: ctx.getOfflineMediaSrcs,
    },
  };
}

function createTurn(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
  input: ServerRunStart,
  baseDoc: ProjectDoc,
): AgentTurn {
  const abortController = new AbortController();
  const { draft, draftCtx } = turnContext(ctx, baseDoc);
  state.abortRef.current = abortController;
  state.runningRef.current = true;
  state.setRunning(true);
  state.setProposalStale(false);
  return {
    state,
    projectId,
    trimmed: input.text.trim(),
    retryOptions: {
      askOnly: input.askOnly,
      ...(input.references.length ? { references: [...input.references] } : {}),
    },
    askOnly: input.askOnly,
    baseDoc,
    proposalBaseDoc: baseDoc,
    draft,
    draftCtx,
    ops: [],
    persistentOps: [],
    persistentBeforeDoc: null,
    persistentSnapshot: Promise.resolve(),
    persistentSaveError: undefined,
    draftInvalidated: false,
    assistantText: '',
    completionStatus: 'completed',
    runtimeErrorShown: false,
    toolCallCount: 0,
    runId: input.runId,
    abortController,
  };
}

function applyToolActions(
  turn: AgentTurn,
  input: ServerRunToolAction,
  projectId: string,
): void {
  if (input.error !== undefined || isFailedToolResult(input.result) || !input.actions.length) return;
  const { persistent, proposed } = partitionProposalActions(input.actions);
  if (persistent.length) {
    const observed = turn.state.ctxRef.current.getDoc();
    if (!turn.persistentBeforeDoc) {
      turn.persistentBeforeDoc = turn.baseDoc;
      turn.persistentSnapshot = saveAutomaticVersion(projectId, 'Agent 修改前', turn.baseDoc).then(
        () => undefined,
        (error) => { turn.persistentSaveError = error; },
      );
    }
    if (serverRunDraftBaseChanged(turn.baseDoc, observed)) turn.draftInvalidated = true;
    turn.proposalBaseDoc = replayActions(turn.proposalBaseDoc, persistent);
    turn.persistentOps.push(buildOperation(input.name, input.args, persistent));
  }
  if (proposed.length) {
    // Count tools that contributed proposal operations so the terminal path
    // can detect a run whose recorded edits failed to survive to settle time.
    turn.toolCallCount += 1;
    turn.ops.push(buildOperation(input.name, input.args, proposed));
  }
  const nextDoc = replayActions(turn.draft.getDoc(), input.actions);
  const next = turnContext(turn.state.ctxRef.current, nextDoc);
  turn.draft = next.draft;
  turn.draftCtx = next.draftCtx;
}

function draftBase(
  input: ServerRunPreparation | ServerRunStart,
  baseDoc: ProjectDoc,
) {
  return {
    text: input.text,
    content: input.content,
    askOnly: input.askOnly,
    references: input.references,
    baseDoc,
  };
}

async function prepareServerRun(
  projectId: string,
  input: ServerRunPreparation,
): Promise<void> {
  if (await loadServerRunDraft(projectId, input.runId)) return;
  await saveServerRunDraftBase(
    projectId,
    input.runId,
    draftBase(input, input.baseDoc),
  );
}

async function loadStartDraft(projectId: string, input: ServerRunStart) {
  const recovered = await loadServerRunDraft(projectId, input.runId);
  if (input.resumed && !recovered) {
    throw permanentServerRunRecoveryError(
      'Server run draft is unavailable; interrupted tools cannot be recovered safely.',
    );
  }
  const baseDoc = recovered?.base.baseDoc ?? input.baseDoc;
  if (!recovered) {
    await saveServerRunDraftBase(projectId, input.runId, draftBase(input, baseDoc));
  }
  return { recovered, baseDoc };
}

function restoreToolActions(
  turn: AgentTurn,
  input: ServerRunStart,
  tools: readonly ServerRunDraftToolBody[],
  baseDoc: ProjectDoc,
  ref: ProposalRunRef,
  projectId: string,
): void {
  for (const tool of tools) {
    ref.current.seenToolCalls.add(tool.toolCallId);
    applyToolActions(turn, {
      runId: input.runId,
      toolCallId: tool.toolCallId,
      argsDigest: tool.argsDigest,
      name: tool.name,
      args: tool.args,
      ...(tool.error === undefined ? { result: tool.result } : { error: tool.error }),
      actions: [...tool.actions],
      baseDoc,
    }, projectId);
  }
}

async function startServerRun(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
  input: ServerRunStart,
  ref: ProposalRunRef,
): Promise<ServerRunRecovery> {
  const { recovered, baseDoc } = await loadStartDraft(projectId, input);
  const turn = createTurn(state, ctx, projectId, input, baseDoc);
  const tools = recovered?.tools ?? [];
  ref.current.turn = turn;
  ref.current.seenToolCalls = new Set();
  restoreToolActions(turn, input, tools, baseDoc, ref, projectId);
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      toolCallId: tool.toolCallId,
      argsDigest: tool.argsDigest,
      ...(tool.error === undefined ? { result: tool.result } : { error: tool.error }),
    })),
    baseDoc,
    draftDoc: turn.draft.getDoc(),
  };
}

async function persistToolAction(
  projectId: string,
  input: ServerRunToolAction,
  ref: ProposalRunRef,
): Promise<void> {
  const turn = ref.current.turn;
  if (!turn || turn.runId !== input.runId) {
    throw new Error('Server run proposal state is unavailable.');
  }
  if (ref.current.seenToolCalls.has(input.toolCallId)) return;
  if (input.error === undefined && !isFailedToolResult(input.result) && input.actions.length) {
    replayActions(turn.draft.getDoc(), input.actions);
  }
  await saveServerRunDraftTool(projectId, input.runId, {
    toolCallId: input.toolCallId,
    argsDigest: input.argsDigest,
    name: input.name,
    args: input.args,
    ...(input.error === undefined ? { result: input.result } : { error: input.error }),
    actions: input.actions,
  });
  ref.current.seenToolCalls.add(input.toolCallId);
  applyToolActions(turn, input, projectId);
}

function beginTerminal(turn: AgentTurn, input: ServerRunTerminal): void {
  turn.assistantText = input.assistantText;
  turn.state.abortRef.current = null;
  turn.state.runningRef.current = false;
  turn.state.setRunning(false);
}

async function finalizeCompletedTurn(
  turn: AgentTurn,
  input: ServerRunTerminal,
): Promise<ServerRunTerminalResolution> {
  let committed: boolean;
  try {
    committed = await commitPersistentOperations(turn);
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    turn.state.setMessages((messages) => [
      ...messages,
      { role: 'error', text: `Agent 已停止，但素材池改动提交失败：${summary}` },
    ]);
    await settleServerRun(turn.projectId, input.runId, {
      status: 'failed',
      summary,
    });
    return 'finalized';
  }
  if (!committed) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'failed',
      summary: 'server run persistent operations failed',
    });
    return 'finalized';
  }
  turn.persistentOps = [];
  turn.persistentBeforeDoc = null;
  if (!turn.ops.length) {
    // A run may legitimately end with no proposed edits (pure reads, or only
    // pool imports committed above). toolCallCount counts only tools that
    // contributed proposal operations, so a non-zero count here means their
    // ops failed to survive to settle time — surface it instead of showing
    // the model's success reply while the timeline stays empty.
    if (turn.toolCallCount > 0) {
      // Mutating tools executed successfully, but no proposal operations
      // survived to settle time. Settling "completed" here would show the
      // model's success reply while the timeline stays empty — surface it.
      turn.state.setMessages((messages) => [
        ...messages,
        {
          role: 'error',
          text: 'Agent 已完成运行，但本次编辑未被记录为可应用的操作（提案为空），时间线未改动。请重试，或打开运行检查器查看详情。',
        },
      ]);
      await settleServerRun(turn.projectId, input.runId, {
        status: 'failed',
        summary: 'server run completed with no recorded proposal operations',
      });
      return 'finalized';
    }
    await settleServerRun(turn.projectId, input.runId, {
      status: 'completed',
      summary: input.assistantText || 'server run completed',
    });
    return 'finalized';
  }
  let proposal;
  try {
    proposal = await createPendingProposal(turn, undefined, false);
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    turn.state.setMessages((messages) => [
      ...messages,
      { role: 'error', text: `Agent 已停止，但提案生成失败，编辑未应用：${summary}` },
    ]);
    await settleServerRun(turn.projectId, input.runId, {
      status: 'failed',
      summary,
    });
    return 'finalized';
  }
  if (!proposal) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'aborted',
      summary: 'server run proposal was not exposed',
    });
    return 'finalized';
  }
  return {
    disposition: 'waiting_approval',
    afterModelCommit: () => exposePendingProposal(turn, proposal),
    onAbandon: () => discardUnexposedProposal(turn.projectId, proposal),
  };
}

async function resolveTerminalDisposition(
  turn: AgentTurn,
  input: ServerRunTerminal,
): Promise<ServerRunTerminalResolution> {
  if (turn.completionStatus === 'waiting_approval') {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'waiting_approval',
      summary: 'server run proposal awaiting approval',
    });
    return 'waiting_approval';
  }
  // A run that ends with a follow-up question still owns its recorded edits:
  // dropping them here settled "completed" while the model reported success
  // and the timeline stayed empty. Only question-only runs settle directly;
  // runs with recorded work go through the same proposal path as completed.
  const hasPendingWork = turn.ops.length > 0 || turn.persistentOps.length > 0;
  if (input.status === 'awaiting_user' && !hasPendingWork) {
    turn.completionStatus = 'awaiting_user';
    await settleServerRun(turn.projectId, input.runId, {
      status: 'completed',
      summary: input.assistantText || 'server run awaiting user input',
    });
    return 'finalized';
  }
  if (input.status !== 'completed' && input.status !== 'awaiting_user') {
    turn.completionStatus = input.status === 'cancelled' ? 'aborted' : 'failed';
    await settleServerRun(turn.projectId, input.runId, {
      status: turn.completionStatus,
      summary: input.assistantText || turn.completionStatus,
    });
    return 'finalized';
  }
  return finalizeCompletedTurn(turn, input);
}

async function finishServerRun(
  projectId: string,
  input: ServerRunTerminal,
  ref: ProposalRunRef,
): Promise<ServerRunTerminalResolution | false> {
  const cached = ref.current.handoffs.get(input.runId);
  if (cached) return cached;
  const turn = ref.current.turn;
  if (!turn || turn.runId !== input.runId) return false;
  beginTerminal(turn, input);
  const disposition = await resolveTerminalDisposition(turn, input);
  if (typeof disposition === 'object') {
    return ref.current.handoffs.retain(input.runId, disposition, async () => {
      if (ref.current.turn?.runId === input.runId) ref.current.turn = null;
      await clearServerRunDraft(projectId, input.runId).catch(() => undefined);
    });
  }
  ref.current.turn = null;
  await clearServerRunDraft(projectId, input.runId).catch(() => undefined);
  return disposition;
}

export function useServerRunProposalCallbacks(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
) {
  const ref = useRef<ProposalRunState>({
    turn: null,
    seenToolCalls: new Set(),
    handoffs: new ServerRunTerminalHandoffs(),
  });
  const onRunPrepare = useCallback(
    (input: ServerRunPreparation) => prepareServerRun(projectId, input),
    [projectId],
  );
  const onRunAbandon = useCallback(async (runId: string) => {
    await ref.current.handoffs.clear(runId);
    if (ref.current.turn?.runId === runId) ref.current.turn = null;
    await clearServerRunDraft(projectId, runId);
  }, [projectId]);
  const onRunStart = useCallback(
    (input: ServerRunStart) => startServerRun(state, ctx, projectId, input, ref),
    [ctx, projectId, state],
  );
  const onToolAction = useCallback(
    (input: ServerRunToolAction) => persistToolAction(projectId, input, ref),
    [projectId],
  );
  const onTerminal = useCallback(
    (input: ServerRunTerminal) => finishServerRun(projectId, input, ref),
    [projectId],
  );
  return { onRunPrepare, onRunAbandon, onRunStart, onToolAction, onTerminal };
}
