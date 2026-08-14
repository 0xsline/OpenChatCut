import { useEffect, useRef } from 'react';
import { settleAbandonedServerRun } from './serverRunAbandon';
import { releaseServerRunOwnership } from './serverRunOwnership';
import {
  clearStoredServerRun,
} from './serverRunSessionStorage';
import type { ServerRunState } from './serverRunState';

interface AbandonedProjectRun {
  readonly projectId: string;
  readonly runId: string;
  readonly capability: string | null;
  readonly onRunAbandon?: (runId: string) => void | Promise<void>;
}

async function settleProjectSwitch(run: AbandonedProjectRun): Promise<void> {
  try {
    await settleAbandonedServerRun({
      projectId: run.projectId,
      runId: run.runId,
      capability: run.capability,
      summary: 'Server run interrupted because the project changed.',
    });
    await run.onRunAbandon?.(run.runId);
    clearStoredServerRun(run.projectId, run.runId);
  } catch {
    // Recovery credentials remain available when permanent settlement cannot complete.
  } finally {
    releaseServerRunOwnership(run.projectId, run.runId);
  }
}

function detachSwitchedRun(state: ServerRunState): void {
  state.refs.abort.current?.abort();
  state.eventSession.close();
  state.refs.runExecutor.current?.stop();
  state.refs.abort.current = null;
  state.refs.runId.current = null;
  state.refs.capability.current = null;
  state.refs.runProject.current = null;
  state.refs.runId.current = null;
  state.refs.activeOptions.current = null;
  state.refs.runExecutor.current = null;
  state.refs.running.current = false;
  state.refs.cursor.current = 0;
  state.refs.assistantText.current = '';
  state.refs.assistantThinking.current = '';
  state.refs.staleRecoveryRun.current = null;
  state.setRunning(false);
}

export function useServerRunProjectSwitch(
  projectId: string,
  state: ServerRunState,
): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const current = stateRef.current;
    const oldProject = current.refs.runProject.current;
    if (!oldProject || oldProject === projectId) return;
    const runId = current.refs.runId.current;
    const abandoned = runId ? {
      projectId: oldProject,
      runId,
      capability: current.refs.capability.current,
      onRunAbandon: current.refs.activeOptions.current?.onRunAbandon,
    } : null;
    detachSwitchedRun(current);
    if (abandoned) void settleProjectSwitch(abandoned);
  }, [projectId]);
}

export function useServerRunUnmount(state: ServerRunState): void {
  useEffect(() => () => {
    state.refs.abort.current?.abort();
    const runId = state.refs.runId.current;
    const runProject = state.refs.runProject.current;
    if (runId && runProject) releaseServerRunOwnership(runProject, runId);
  }, [state.refs]);
}
