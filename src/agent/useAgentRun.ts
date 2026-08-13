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
import { appendAgentChange, createAgentChangeSession } from './changeLog';
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



