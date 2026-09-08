import type { ProjectDoc } from '../editor/types';
import { replayActions, type DraftEngine } from '../editor/store';
import { saveProject } from '../persist/projectStore';
import { clearProposal, saveProposal, settleProposal } from '../persist/proposalStore';
import type { AgentContext } from './context';
import { PROVIDER } from './providerConfig';
import type { AgentRetryOptions } from './agent-session';
import {
  buildProposal,
  type Operation,
  type Proposal,
} from './proposal';
import { appendAgentChange, createAgentChangeSession, extendAgentChangeSession } from './changeLog';
import { settleServerRun } from './serverRunSettleClient';
import type { AgentRunStatus } from '../persist/agentRuntimeStore';
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
  /** The run's single change-log row; every landing (imports and, in auto mode, edits) extends it. */
  runSessionId: string | null;
  /** Auto-apply: timeline edits land after each tool call instead of becoming a proposal. */
  liveEdits: boolean;
  persistentSnapshot: Promise<void>;
  persistentSaveError: unknown;
  draftInvalidated: boolean;
  assistantText: string;
  completionStatus: AgentRunStatus;
  runtimeErrorShown: boolean;
  toolCallCount: number;
  runId: string;
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
    // Approval mode keeps provider routing and the mode-aware prompt aligned;
    // offline media sources keep pool reachability checks accurate while drafting.
    getApprovalMode: ctx.getApprovalMode,
    getOfflineMediaSrcs: ctx.getOfflineMediaSrcs,
  };
}
export function statusAfterMaxToolTurns(status: AgentRunStatus): AgentRunStatus {
  return status === 'awaiting_user' ? 'completed' : status;
}




function showRunError(turn: AgentTurn, text: string): void {
  turn.completionStatus = 'failed';
  turn.state.setMessages((messages) => [...messages, { role: 'error', text }]);
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
  if (!turn.persistentOps.length) return true;
  // Pool imports are additive, so they land on whatever the project is now — called after
  // every tool that imported something, not once at the end of the run.
  const landed = await landOperations(turn, turn.persistentOps, persist);
  if (!landed) return false;
  turn.persistentOps = [];
  return true;
}

/**
 * Auto-apply mode: the timeline edits recorded so far land now, the way a proposal would
 * have been applied at the end of the run, so the user watches the tracks change as the
 * agent works. The returned document is the new base for the draft and the proposal.
 */
export async function landProposedOperations(
  turn: AgentTurn,
  persist: typeof saveProject = saveProject,
): Promise<ProjectDoc | null> {
  if (!turn.ops.length || turn.abortController.signal.aborted) return null;
  const operations = turn.ops;
  const landed = await landOperations(turn, operations, persist);
  if (!landed) return null;
  turn.ops = [];
  // Each operation came from one tool call; those calls are settled, not pending.
  turn.toolCallCount = Math.max(0, turn.toolCallCount - operations.length);
  turn.proposalBaseDoc = landed;
  return landed;
}

/**
 * Replay `operations` onto the live project and save. A user edit made while the agent was
 * working neither blocks the landing nor gets overwritten: the save is the fence, and if
 * the project moved during it the saved copy lacks that edit, so the live document is put
 * back and the operations are replayed on top of it.
 */
async function landOperations(
  turn: AgentTurn,
  operations: readonly Operation[],
  persist: typeof saveProject,
): Promise<ProjectDoc | null> {
  const actions = operations.flatMap((operation) => operation.actions);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentDoc = turn.state.ctxRef.current.getDoc();
    const afterDoc = replayActions(currentDoc, actions);
    // Everything is already there (a resumed run replaying its own landings).
    if (afterDoc === currentDoc) return currentDoc;
    const saved = await persist(turn.projectId, afterDoc).catch(() => null);
    if (!saved?.saved) {
      showRunError(turn, '无法保存工程，Agent 改动未应用。请检查本地存储后重试。');
      return null;
    }
    const liveDoc = turn.state.ctxRef.current.getDoc();
    if (turn.abortController.signal.aborted || liveDoc !== currentDoc) {
      const restored = await persist(turn.projectId, liveDoc).catch(() => null);
      if (turn.abortController.signal.aborted) {
        if (!restored?.saved) showRunError(turn, 'Agent 已停止，但无法恢复工程存储。请重新打开工程并检查内容。');
        return null;
      }
      continue;
    }
    turn.state.ctxRef.current.commands.applyDoc(afterDoc);
    recordRunSession(turn, operations, currentDoc, afterDoc);
    return afterDoc;
  }
  showRunError(turn, '保存期间工程持续发生其他修改，Agent 改动暂未应用；请稍后重试。');
  return null;
}

function recordRunSession(
  turn: AgentTurn,
  operations: readonly Operation[],
  beforeDoc: ProjectDoc,
  afterDoc: ProjectDoc,
): void {
  const id = turn.runSessionId;
  if (id) {
    turn.state.setChangeLog((current) => current.map((session) => (
      session.id === id ? extendAgentChangeSession(session, operations, afterDoc) : session
    )));
    return;
  }
  const session = createAgentChangeSession(
    turn.assistantText || RUN_SESSION_PLACEHOLDER, operations, beforeDoc, afterDoc, true,
  );
  turn.runSessionId = session.id;
  turn.state.setChangeLog((current) => appendAgentChange(current, session));
}

const RUN_SESSION_PLACEHOLDER = 'Agent 修改（进行中）';

/** The run is over: the row it grew during the run gets the model's own summary. */
export function finalizeRunSession(turn: AgentTurn): void {
  const id = turn.runSessionId;
  const summary = turn.assistantText.trim();
  if (!id || !summary) return;
  turn.state.setChangeLog((current) => current.map((session) => (
    session.id === id && session.summary === RUN_SESSION_PLACEHOLDER ? { ...session, summary } : session
  )));
}

export async function discardUnexposedProposal(projectId: string, proposal: Proposal): Promise<void> {
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
  if (!turn.runId) return null;
  const proposal = buildProposal(
    turn.ops, turn.assistantText, turn.proposalBaseDoc, turn.draft.getState(), turn.runId,
  );
  await persist(turn.projectId, proposal);
  if (turn.abortController.signal.aborted) {
    await discardUnexposedProposal(turn.projectId, proposal);
    return null;
  }
  try {
    await settleServerRun(turn.projectId, turn.runId, {
      status: 'waiting_approval',
      proposalId: proposal.id,
      proposalRuntimeStatus: 'created',
    });
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



