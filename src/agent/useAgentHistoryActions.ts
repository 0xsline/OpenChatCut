import { useCallback, useRef } from 'react';
import { flushChatWrites } from '../persist/projectStore';
import { clearAgentSessionContext } from '../persist/agentRuntimeStore';
import { loadProposalRecord } from '../persist/proposalStore';
import { initialAgentMessages } from './agent-session';
import { PROVIDER } from './providerConfig';
import { canRollbackAgentChange, rollbackAgentChange } from './changeLog';
import type { AgentHookState } from './useAgentState';

export async function clearAgentHistory(state: AgentHookState, projectId: string): Promise<void> {
  if (state.runningRef.current) return;
  const hydrationEpoch = ++state.hydrationEpochRef.current;
  state.hydratedRef.current = false;
  state.setHydrated(false);
  try {
    await flushChatWrites(projectId);
    const durable = await loadProposalRecord(projectId);
    const durableRunId = durable?.phase !== 'settled'
      ? durable?.proposal.agentRunId
      : undefined;
    await clearAgentSessionContext(
      projectId,
      durableRunId ? new Set([durableRunId]) : new Set(),
    );
  } catch {
    if (state.hydrationEpochRef.current !== hydrationEpoch) return;
    state.hydratedRef.current = true;
    state.setHydrated(true);
    state.setMessages((current) => [...current, {
      role: 'error',
      text: '无法清空上下文与运行记录。请确认没有其他 Agent 正在运行，并重试。',
    }]);
    return;
  }
  if (state.hydrationEpochRef.current !== hydrationEpoch) return;
  state.llmRef.current = initialAgentMessages();
  state.toolFailuresRef.current.clear();
  state.llmProviderRef.current = PROVIDER;
  state.setProposal(null);
  state.setProposalStale(false);
  state.setChangeLog([]);
  state.setMessages([]);
  state.replaceContextUsage(null);
  state.hydratedRef.current = true;
  state.setHydrated(true);
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
