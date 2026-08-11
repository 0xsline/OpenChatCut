import type { AgentContext } from './context';
import type {
  ServerRunController,
  ServerRunOptions,
} from './serverRunProtocol';
import { useServerRunControllerActions } from './serverRunControllerActions';
import {
  useServerRunProjectSwitch,
  useServerRunUnmount,
} from './serverRunProjectLifecycle';
import { useServerRunRecoveryLifecycle } from './serverRunRecoveryLifecycle';
import { useServerRunState } from './serverRunState';
import { useServerRunStreamLifecycle } from './serverRunStreamLifecycle';

/** Browser side of the durable server-side Agent run. */
export function useServerRun(
  ctx: AgentContext,
  projectId: string,
  options: ServerRunOptions,
): ServerRunController {
  const state = useServerRunState(ctx, projectId, options);
  const stream = useServerRunStreamLifecycle(projectId, state);
  const actions = useServerRunControllerActions(projectId, state, stream);
  useServerRunProjectSwitch(projectId, state);
  useServerRunRecoveryLifecycle(
    projectId,
    options.enabled,
    options.session?.hydrated,
    state,
    stream,
    actions,
  );
  useServerRunUnmount(state);
  return {
    send: actions.send,
    messages: state.messages,
    running: state.running,
    pendingGuard: state.pendingGuard,
    confirmGuard: actions.confirmGuard,
    stop: actions.stop,
  };
}
