import { useCallback, useMemo, useRef } from 'react';
import type { ModelMessage } from 'ai';
import type { AgentContext } from './context';
import {
  isProposalStale,
  type Proposal,
} from './proposal';
import type { AgentSendOptions } from './useAgentRun';
import type { AgentHookState } from './useAgentState';
import { useAgentProposalActions } from './useAgentProposalActions';
import { useAgentHistoryActions } from './useAgentHistoryActions';
import {
  agentSessionSnapshot,
  useAgentHydration,
  useAgentPersistence,
} from './useAgentPersistence';
import { saveServerRunChat } from '../persist/projectStore';
import type { AgentChangeSession } from './changeLog';
import type {
  ServerRunPreparation,
  ServerRunRecovery,
  ServerRunSession,
  ServerRunStart,
  ServerRunTerminal,
  ServerRunTerminalResolution,
  ServerRunToolAction,
} from './serverRunProtocol';
import { useServerRunProposalCallbacks } from './serverRunProposalLifecycle';

export interface ServerRunProposalBridge {
  readonly onRunPrepare: (input: ServerRunPreparation) => Promise<void>;
  readonly onRunAbandon: (runId: string) => Promise<void>;
  readonly onRunStart: (input: ServerRunStart) => Promise<ServerRunRecovery>;
  readonly onToolAction: (input: ServerRunToolAction) => Promise<void>;
  readonly onTerminal: (
    input: ServerRunTerminal,
  ) => Promise<ServerRunTerminalResolution | false>;
  readonly session: ServerRunSession;
  readonly proposal: Proposal | null;
  readonly proposalStale: boolean;
  readonly changeLog: AgentChangeSession[];
  readonly applyProposal: (selected: Set<number>) => void;
  readonly forceApplyProposal: (selected: Set<number>) => void;
  readonly rejectProposal: () => void;
  readonly reProposeStale: () => void;
  readonly clearHistory: () => void;
  readonly rollbackChangeSession: (id: string, force?: boolean) => boolean;
  readonly canRollbackChangeSession: (id: string) => boolean;
}

function useServerRunSession(
  state: AgentHookState,
  projectId: string,
): ServerRunSession {
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateMessages = useCallback((
    update: (messages: AgentHookState['messages']) => AgentHookState['messages'],
  ) => {
    stateRef.current.setMessages(update);
  }, []);
  const commitModelTurn = useCallback(async (
    runId: string,
    modelHistoryLength: number,
    userContent: string,
    assistantText: string,
  ): Promise<void> => {
    const current = stateRef.current;
    const previous = current.llmRef.current;
    const next = [
      ...previous.slice(0, Math.min(modelHistoryLength, previous.length)),
      { role: 'user', content: userContent },
      ...(assistantText ? [{ role: 'assistant', content: assistantText } as const] : []),
    ] as ModelMessage[];
    current.llmRef.current = next;
    current.refreshEstimatedContextUsage();
    let committed: boolean;
    try {
      committed = await saveServerRunChat(
        projectId,
        runId,
        agentSessionSnapshot(current, next),
      );
    } catch (error) {
      if (current.llmRef.current === next) current.llmRef.current = previous;
      current.refreshEstimatedContextUsage();
      throw error;
    }
    if (!committed && current.llmRef.current === next) {
      current.llmRef.current = previous;
      current.refreshEstimatedContextUsage();
    }
  }, [projectId]);
  return useMemo<ServerRunSession>(() => ({
    hydrated: state.hydrated,
    messages: state.messages,
    updateMessages,
    modelMessages: () => stateRef.current.llmRef.current,
    commitModelTurn,
  }), [commitModelTurn, state.hydrated, state.messages, updateMessages]);
}

/** Adapts server-run browser tool actions to the existing durable proposal path. */
export function useServerRunProposalBridge(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
  enabled: boolean,
  send: (text: string, options?: AgentSendOptions) => void,
): ServerRunProposalBridge {
  useAgentHydration(state, projectId, enabled);
  useAgentPersistence(state, projectId, enabled);
  const sendAgent = useCallback(async (text: string, options?: AgentSendOptions) => {
    send(text, options);
  }, [send]);
  const proposalActions = useAgentProposalActions(state, projectId, sendAgent);
  const historyActions = useAgentHistoryActions(state, projectId);
  const callbacks = useServerRunProposalCallbacks(state, ctx, projectId);
  const session = useServerRunSession(state, projectId);
  return {
    ...callbacks,
    session,
    proposal: state.proposal,
    proposalStale: state.proposalStale || Boolean(
      state.proposal && isProposalStale(state.proposal, ctx.getDoc()),
    ),
    changeLog: state.changeLog,
    ...proposalActions,
    ...historyActions,
  };
}
