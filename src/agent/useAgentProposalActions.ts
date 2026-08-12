import { useCallback, useRef } from 'react';
import { replayActions } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import {
  clearProposal,
  markProposalApplying,
  settleProposal,
  type ProposalSettlementOutcome,
} from '../persist/proposalStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import { saveProject } from '../persist/projectStore';
import { appendAgentChange, createAgentChangeSession } from './changeLog';
import { isProposalStale, type Proposal } from './proposal';
import { appendRejectedProposal } from './agent-session';
import { recordProposalOutcome } from './useAgentPersistence';
import type { AgentSend } from './useAgentRun';
import type { AgentHookState } from './useAgentState';
import {
  clearStoredServerRun,
} from './serverRunSessionStorage';
import { settleServerRun } from './serverRunSettleClient';

export interface ProposalPersistence {
  readonly saveVersion: typeof saveAutomaticVersion;
  readonly saveDoc: typeof saveProject;
  readonly markApplying: typeof markProposalApplying;
  readonly settle: typeof settleProposal;
  readonly clear: typeof clearProposal;
}

const DEFAULT_PROPOSAL_PERSISTENCE: ProposalPersistence = {
  saveVersion: saveAutomaticVersion,
  saveDoc: saveProject,
  markApplying: markProposalApplying,
  settle: settleProposal,
  clear: clearProposal,
};

const OUTCOME_STATUS: Record<ProposalSettlementOutcome, {
  runtime: 'applied' | 'rejected' | 'stale' | 'reproposed';
  final: 'completed' | 'aborted' | 'waiting_approval';
  summary: string;
}> = {
  applied: { runtime: 'applied', final: 'completed', summary: 'proposal applied' },
  rejected: { runtime: 'rejected', final: 'aborted', summary: 'proposal rejected' },
  stale: { runtime: 'stale', final: 'waiting_approval', summary: 'proposal became stale' },
  reproposed: { runtime: 'reproposed', final: 'aborted', summary: 'proposal replaced' },
};

function showProposalError(state: AgentHookState, text: string): void {
  state.setMessages((current) => [...current, { role: 'error', text }]);
}

async function settleAndRecord(
  projectId: string,
  proposal: Proposal,
  outcome: ProposalSettlementOutcome,
  persistence: ProposalPersistence,
): Promise<void> {
  await persistence.settle(projectId, proposal, outcome);
  const status = OUTCOME_STATUS[outcome];
  await recordProposalOutcome(projectId, proposal, status.runtime, status.final, status.summary);
}

async function claimProposalRun(
  proposal: Proposal,
): Promise<boolean> {
  // The server owns the run ledger; applying a proposal only needs the
  // proposal record to still reference a live run (the settle endpoint is
  // idempotent for terminal/missing runs, so no ownership handshake is
  // required in the browser).
  return Boolean(proposal.agentRunId && proposal.id);
}

async function confirmOwnershipBeforeApply(_available: boolean): Promise<void> {
  // Ownership authority lives on the server; nothing to prove client-side.
}

async function restoreConcurrentProject(
  state: AgentHookState,
  projectId: string,
  proposal: Proposal,
  currentDoc: ProjectDoc,
  persistence: ProposalPersistence,
): Promise<boolean> {
  if (state.proposalRef.current === proposal && state.ctxRef.current.getDoc() === currentDoc) return false;
  const latestDoc = state.ctxRef.current.getDoc();
  const restored = await persistence.saveDoc(projectId, latestDoc).catch(() => null);
  if (!restored?.saved) {
    throw new Error('The newer live project could not be saved; proposal recovery remains pending.');
  }
  await settleAndRecord(projectId, proposal, 'stale', persistence);
  state.setProposalStale(true);
  return true;
}

function commitAppliedUi(
  state: AgentHookState,
  proposal: Proposal,
  chosen: Proposal['options'][number]['operations'],
  currentDoc: ProjectDoc,
  result: ProjectDoc,
): void {
  state.ctxRef.current.commands.applyDoc(result);
  const session = createAgentChangeSession(proposal.summary, chosen, currentDoc, result);
  state.setChangeLog((current) => appendAgentChange(current, session));
  state.llmRef.current.push({
    role: 'user',
    content: `（已应用提案：${chosen.length}/${proposal.options[0].operations.length} 项操作。）`,
  });
  state.refreshEstimatedContextUsage();
  state.setProposalStale(false);
  state.setProposal(null);
}

async function cleanupAppliedProposal(
  proposal: Proposal,
  operationCount: number,
  projectId: string,
  persistence: ProposalPersistence,
): Promise<string | null> {
  try {
    if (proposal.agentRunId && proposal.id) {
      await settleServerRun(projectId, proposal.agentRunId, {
        status: 'completed',
        proposalId: proposal.id,
        proposalRuntimeStatus: 'applied',
        summary: `applied ${operationCount} operations`,
      });
      clearStoredServerRun(projectId, proposal.agentRunId);
    }
  } catch {
    return '提案已应用，但运行记录尚未完成；重新打开工程时会继续恢复。';
  }
  try {
    await persistence.clear(projectId, proposal.id);
    return null;
  } catch {
    return '提案已应用，但恢复记录暂未清理；它已标记为不可重放。';
  }
}
class CommittedProposalRecoveryError extends Error {}

async function persistSelectedProposal(
  state: AgentHookState,
  projectId: string,
  proposal: Proposal,
  currentDoc: ProjectDoc,
  result: ProjectDoc,
  operationCount: number,
  persistence: ProposalPersistence,
): Promise<boolean> {
  await persistence.saveVersion(projectId, 'Agent 修改前', currentDoc);
  if (state.proposalRef.current !== proposal || state.ctxRef.current.getDoc() !== currentDoc) {
    await settleAndRecord(projectId, proposal, 'stale', persistence);
    state.setProposalStale(true);
    return false;
  }
  await confirmOwnershipBeforeApply(true);
  await persistence.markApplying(projectId, proposal, result, operationCount);
  const saved = await persistence.saveDoc(projectId, result);
  if (!saved.saved) throw new Error('project save failed');
  if (await restoreConcurrentProject(state, projectId, proposal, currentDoc, persistence)) {
    return false;
  }
  try {
    await persistence.settle(projectId, proposal, 'applied');
  } catch {
    throw new CommittedProposalRecoveryError();
  }
  return true;
}


export async function applySelectedProposal(
  state: AgentHookState,
  projectId: string,
  selected: Set<number>,
  persistence: ProposalPersistence = DEFAULT_PROPOSAL_PERSISTENCE,
): Promise<void> {
  const proposal = state.proposalRef.current;
  if (!proposal || state.applyingProposalRef.current) return;
  state.applyingProposalRef.current = true;
  const currentDoc = state.ctxRef.current.getDoc();
  const chosen = proposal.options[0].operations.filter((_, index) => selected.has(index));
  const result = replayActions(currentDoc, chosen.flatMap((operation) => operation.actions));
  try {
    await claimProposalRun(proposal);
    const persisted = await persistSelectedProposal(
      state, projectId, proposal, currentDoc, result, chosen.length, persistence,
    );
    if (!persisted) return;
    commitAppliedUi(state, proposal, chosen, currentDoc, result);
    const warning = await cleanupAppliedProposal(
      proposal, chosen.length, projectId, persistence,
    );
    if (warning) showProposalError(state, warning);
  } catch (error) {
    if (error instanceof CommittedProposalRecoveryError) {
      commitAppliedUi(state, proposal, chosen, currentDoc, result);
      showProposalError(state, '提案已保存到工程，但恢复记录尚未完成；请重新打开工程确认。');
    } else {
      showProposalError(state, '无法取得提案运行权限、保存工程或创建修改前版本，提案未应用。请重试。');
    }
  } finally {
    state.applyingProposalRef.current = false;
  }
}

function applyUnlessStale(
  state: AgentHookState,
  projectId: string,
  selected: Set<number>,
): void {
  const proposal = state.proposalRef.current;
  if (!proposal) return;
  if (isProposalStale(proposal, state.ctxRef.current.getDoc())) {
    state.setProposalStale(true);
    void settleAndRecord(projectId, proposal, 'stale', DEFAULT_PROPOSAL_PERSISTENCE)
      .catch(() => showProposalError(state, '无法持久化过期提案状态；提案不会被应用。'));
    return;
  }
  void applySelectedProposal(state, projectId, selected);
}

async function replaceStaleProposal(
  state: AgentHookState,
  projectId: string,
  send: AgentSend,
): Promise<void> {
  const previous = state.proposalRef.current;
  if (!previous) return;
  try {
    await settleAndRecord(projectId, previous, 'reproposed', DEFAULT_PROPOSAL_PERSISTENCE);
    await DEFAULT_PROPOSAL_PERSISTENCE.clear(projectId, previous.id);
  } catch {
    showProposalError(state, '无法持久化提案替换状态，请重试。');
    return;
  }
  state.setProposalStale(false);
  state.setProposal(null);
  state.proposalRef.current = null;
  await send('（工程在上一提案生成后发生了变化。请基于当前 <editor_state> 重新提出与上一提案等价的修改方案。）');
}

export async function rejectPendingProposal(
  state: AgentHookState,
  projectId: string,
  persistence: ProposalPersistence = DEFAULT_PROPOSAL_PERSISTENCE,
): Promise<void> {
  const previous = state.proposalRef.current;
  if (!previous) return;
  try {
    await persistence.settle(projectId, previous, 'rejected');
  } catch {
    showProposalError(state, '无法持久化提案拒绝状态，提案未拒绝。请重试。');
    return;
  }
  let warning: string | null = null;
  try {
    const status = OUTCOME_STATUS.rejected;
    await recordProposalOutcome(projectId, previous, status.runtime, status.final, status.summary);
    await persistence.clear(projectId, previous.id);
  } catch {
    warning = '提案已拒绝，但运行记录尚未完成；重新打开工程时会继续清理。';
  }
  state.setProposalStale(false);
  state.llmRef.current = appendRejectedProposal(state.llmRef.current);
  state.refreshEstimatedContextUsage();
  state.setProposal(null);
  if (warning) showProposalError(state, warning);
}

export function useAgentProposalActions(
  state: AgentHookState,
  projectId: string,
  send: AgentSend,
) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const applyProposal = useCallback((selected: Set<number>) => {
    applyUnlessStale(stateRef.current, projectId, selected);
  }, [projectId]);
  const forceApplyProposal = useCallback((selected: Set<number>) => {
    void applySelectedProposal(stateRef.current, projectId, selected);
  }, [projectId]);
  const reProposeStale = useCallback(() => {
    void replaceStaleProposal(stateRef.current, projectId, send);
  }, [projectId, send]);
  const rejectProposal = useCallback(() => {
    void rejectPendingProposal(stateRef.current, projectId);
  }, [projectId]);
  return { applyProposal, forceApplyProposal, reProposeStale, rejectProposal };
}
