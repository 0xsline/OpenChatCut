import type { AgentContext } from './context';
import type { AgentContextUsage } from './context-compaction';
import type { DisplayMessage, LiveTool, PendingGuard } from './agent-session';
import type { AgentChangeSession } from './changeLog';
import type { Proposal } from './proposal';
import { useAgentState } from './useAgentState';
import { useAgentHydration, useAgentPersistence } from './useAgentPersistence';
import { useAgentRun, type AgentSend } from './useAgentRun';
import { useAgentProposalActions } from './useAgentProposalActions';
import { useAgentHistoryActions } from './useAgentHistoryActions';

export interface AgentController {
  readonly messages: DisplayMessage[];
  readonly running: boolean;
  readonly hydrated: boolean;
  readonly contextUsage: AgentContextUsage | null;
  readonly proposal: Proposal | null;
  readonly proposalStale: boolean;
  readonly pendingGuard: PendingGuard | null;
  readonly liveTool: LiveTool | null;
  readonly changeLog: AgentChangeSession[];
  readonly send: AgentSend;
  readonly stop: () => void;
  readonly enhance: (prompt: string) => Promise<string>;
  readonly clearHistory: () => void;
  readonly applyProposal: (selected: Set<number>) => void;
  readonly forceApplyProposal: (selected: Set<number>) => void;
  readonly reProposeStale: () => void;
  readonly rejectProposal: () => void;
  readonly rollbackChangeSession: (id: string, force?: boolean) => boolean;
  readonly canRollbackChangeSession: (id: string) => boolean;
}

/** Compose the built-in chat Agent from focused state, runtime, proposal, and history hooks. */
export function useAgent(ctx: AgentContext, projectId: string): AgentController {
  const state = useAgentState(ctx);
  useAgentHydration(state, projectId);
  useAgentPersistence(state, projectId);
  const runtime = useAgentRun(state, projectId);
  const proposalActions = useAgentProposalActions(state, projectId, runtime.send);
  const historyActions = useAgentHistoryActions(state, projectId);
  return {
    messages: state.messages,
    running: state.running,
    hydrated: state.hydrated,
    contextUsage: state.contextUsage,
    proposal: state.proposal,
    proposalStale: state.proposalStale,
    pendingGuard: state.pendingGuard,
    liveTool: state.liveTool,
    changeLog: state.changeLog,
    ...runtime,
    ...proposalActions,
    ...historyActions,
  };
}
