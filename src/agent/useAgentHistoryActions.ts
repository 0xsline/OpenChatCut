import { useCallback, useRef } from 'react';
import { clearProposal, settleProposal } from '../persist/proposalStore';
import { initialAgentMessages } from './agent-session';
import { PROVIDER } from './providerConfig';
import { canRollbackAgentChange, rollbackAgentChange } from './changeLog';
import { recordProposalOutcome } from './useAgentPersistence';
import type { AgentHookState } from './useAgentState';

async function clearAgentHistory(state: AgentHookState, projectId: string): Promise<void> {
  if (state.runningRef.current) return;
  const previous = state.proposalRef.current;
  try {
    if (previous) {
      await settleProposal(projectId, previous, 'rejected');
      await recordProposalOutcome(projectId, previous, 'rejected', 'aborted', 'proposal cleared with chat');
    }
    await clearProposal(projectId, previous?.id);
  } catch {
    state.setMessages((current) => [...current, {
      role: 'error',
      text: '无法持久化提案清理状态，聊天记录未清除。请重试。',
    }]);
    return;
  }
  state.llmRef.current = initialAgentMessages();
  state.toolFailuresRef.current.clear();
  state.llmProviderRef.current = PROVIDER;
  state.setProposal(null);
  state.setMessages([]);
  state.replaceContextUsage(null);
}

function rollbackSession(state: AgentHookState, id: string, force: boolean): boolean {
  const session = state.changeLogRef.current.find((item) => item.id === id);
  if (!session) return false;
  const previous = rollbackAgentChange(session, state.ctxRef.current.getDoc(), force);
  if (!previous) return false;
  state.ctxRef.current.commands.applyDoc(previous);
  return true;
}

function canRollbackSession(state: AgentHookState, id: string): boolean {
  const session = state.changeLogRef.current.find((item) => item.id === id);
  return !!session && canRollbackAgentChange(session, state.ctxRef.current.getDoc());
}

export function useAgentHistoryActions(state: AgentHookState, projectId: string) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const clearHistory = useCallback(
    () => { void clearAgentHistory(stateRef.current, projectId); },
    [projectId],
  );
  const rollbackChangeSession = useCallback(
    (id: string, force = false) => rollbackSession(stateRef.current, id, force),
    [],
  );
  const canRollbackChangeSession = useCallback(
    (id: string) => canRollbackSession(stateRef.current, id),
    [],
  );
  return { clearHistory, rollbackChangeSession, canRollbackChangeSession };
}
