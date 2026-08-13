import { useCallback, useRef } from 'react';
import type { AgentSend } from './useAgentRun';
import { sendServerRun } from './serverRunSend';
import { requestServerRunCancellation } from './serverRunProtocol';
import { readStoredServerRun } from './serverRunSessionStorage';
import type { ServerRunState } from './serverRunState';
import type { ServerRunStreamLifecycle } from './serverRunStreamLifecycle';

export interface ServerRunControllerActions {
  readonly send: AgentSend;
  readonly stop: () => void;
}


export function useServerRunControllerActions(
  projectId: string,
  state: ServerRunState,
  stream: ServerRunStreamLifecycle,
): ServerRunControllerActions {
  const stateRef = useRef(state);
  const streamRef = useRef(stream);
  stateRef.current = state;
  streamRef.current = stream;
  const send = useCallback<AgentSend>((text, options) => {
    const current = stateRef.current;
    const lifecycle = streamRef.current;
    current.refs.activeOptions.current = current.refs.options.current;
    current.refs.runExecutor.current = current.toolExecutor;
    return sendServerRun({
      projectId,
      refs: current.refs,
      setRunning: current.setRunning,
      updateMessages: current.updateMessages,
      appendMessage: current.appendMessage,
      toolExecutor: current.toolExecutor,
      subscribe: lifecycle.subscribe,
      finishRun: lifecycle.finishRun,
      scheduleRecovery: lifecycle.scheduleRecovery,
      scheduleAdmissionRecovery: (recover) => {
        current.eventSession.scheduleRecovery(recover);
      },
      abandonStaleRecovery: lifecycle.abandonStaleRecovery,
    }, text, options);
  }, [projectId]);
  const stop = useCallback(() => {
    const current = stateRef.current;
    const lifecycle = streamRef.current;
    const runId = current.refs.runId.current;
    const capability = current.refs.capability.current;
    const admissionPending = readStoredServerRun(projectId)?.admissionPending === true;
    const transport = current.refs.abort.current;
    if (transport && !transport.signal.aborted) {
      transport.abort(new Error('Server run stopped by the user.'));
    }
    current.refs.runExecutor.current?.stop();
    if (!runId || !capability) return;
    void requestServerRunCancellation(projectId, runId, capability).then((status) => {
      if (status === 'cancelled') void lifecycle.finishRun(runId, status);
      else lifecycle.subscribe(runId);
    }).catch((error: unknown) => {
      if (admissionPending) return;
      current.appendMessage({
        role: 'error',
        text: `服务端任务停止失败：${error instanceof Error ? error.message : String(error)}`,
      });
      lifecycle.scheduleRecovery(runId);
    });
  }, [projectId]);
  return { send, stop };
}
