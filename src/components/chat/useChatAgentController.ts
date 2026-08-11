import { useRef } from 'react';
import type { AgentContext } from '../../agent/context';
import { useAgentController, type AgentController } from '../../agent/useAgent';
import { useAgentState } from '../../agent/useAgentState';
import { useServerRun } from '../../agent/useServerRun';
import type { ServerRunController } from '../../agent/serverRunProtocol';
import {
  useServerRunProposalBridge,
  type ServerRunProposalBridge,
} from '../../agent/serverRunProposalBridge';

function serverRunAdapter(
  run: ServerRunController,
  bridge: ServerRunProposalBridge,
  enhance: AgentController['enhance'],
): AgentController {
  return {
    messages: run.messages,
    running: run.running,
    hydrated: bridge.session.hydrated,
    contextUsage: null,
    proposal: bridge.proposal,
    proposalStale: bridge.proposalStale,
    pendingGuard: run.pendingGuard
      ? {
        ...run.pendingGuard,
        resolve: (requested) => run.confirmGuard(requested !== 'deny'),
      }
      : null,
    liveTool: null,
    changeLog: bridge.changeLog,
    send: run.send,
    stop: run.stop,
    enhance,
    clearHistory: bridge.clearHistory,
    applyProposal: bridge.applyProposal,
    forceApplyProposal: bridge.forceApplyProposal,
    rejectProposal: bridge.rejectProposal,
    reProposeStale: bridge.reProposeStale,
    rollbackChangeSession: bridge.rollbackChangeSession,
    canRollbackChangeSession: bridge.canRollbackChangeSession,
  };
}

export function useChatAgentController(
  ctx: AgentContext,
  projectId: string,
  serverRunEnabled: boolean,
): AgentController {
  const state = useAgentState(ctx);
  const backend = useRef({ mode: serverRunEnabled, running: false });
  const effectiveServerRun = backend.current.running
    ? backend.current.mode
    : serverRunEnabled;
  const builtInAgent = useAgentController(state, projectId, !effectiveServerRun);
  const serverRunRef = useRef<AgentController['send']>(() => Promise.resolve());
  const bridge = useServerRunProposalBridge(
    state,
    ctx,
    projectId,
    effectiveServerRun,
    (text, options) => { void serverRunRef.current(text, options); },
  );
  const run = useServerRun(ctx, projectId, {
    enabled: effectiveServerRun,
    session: bridge.session,
    onRunPrepare: bridge.onRunPrepare,
    onRunAbandon: bridge.onRunAbandon,
    onRunStart: bridge.onRunStart,
    onToolAction: bridge.onToolAction,
    onTerminal: bridge.onTerminal,
  });
  serverRunRef.current = run.send;
  const running = state.running || builtInAgent.running || run.running;
  backend.current = { mode: effectiveServerRun, running };
  return effectiveServerRun
    ? serverRunAdapter(run, bridge, builtInAgent.enhance)
    : builtInAgent;
}
