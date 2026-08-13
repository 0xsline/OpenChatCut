import type { AgentContextUsage } from './context-compaction';
import type { DisplayMessage, LiveTool } from './agent-session';
import type { AgentChangeSession } from './changeLog';
import type { Proposal } from './proposal';
import type { AgentSend } from './useAgentRun';

/**
 * The controller surface exposed to the chat panel. Server-side execution is
 * the only Agent run path; this type is what the serverRun adapter must expose
 * for the panel to keep working.
 */
export interface AgentController {
  readonly messages: DisplayMessage[];
  readonly running: boolean;
  readonly hydrated: boolean;
  readonly contextUsage: AgentContextUsage | null;
  readonly proposal: Proposal | null;
  readonly proposalStale: boolean;
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
