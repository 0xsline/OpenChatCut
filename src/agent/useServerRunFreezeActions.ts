import { useCallback } from 'react';
import type { ServerRunState } from './serverRunState';
import {
  clearStoredServerRun,
  readStoredServerRun,
} from './serverRunSessionStorage';
import { settleServerRun } from './serverRunSettleClient';
import { releaseServerRunOwnership } from './serverRunOwnership';
import { dropStreamDeltas } from './serverRunStreamDeltaBuffer';

export async function recheckFrozenServerRun(projectId: string, state: ServerRunState): Promise<void> {
  const stored = readStoredServerRun(projectId);
  if (!stored || state.refs.frozenRun.current !== stored.runId) return;
  // The coordinator reads fresh evidence, submits only existing results, and
  // obtains execution authority before reattaching the executor and stream.
  await state.refs.recover.current?.(stored.runId);
}

export async function endFrozenServerRun(projectId: string, state: ServerRunState): Promise<void> {
  const stored = readStoredServerRun(projectId);
  if (!stored || (!stored.paused && state.refs.frozenRun.current !== stored.runId)) return;
  state.eventSession.close();
  state.refs.abort.current?.abort();
  state.toolExecutor.stop();
  try {
    await settleServerRun(projectId, stored.runId, {
      status: 'interrupted',
      summary: '用户结束了暂停的服务端任务。',
    }, true);
  } catch (error) {
    state.appendMessage({ role: 'error', text: `结束任务尚未获得服务端确认，恢复凭据已保留：${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  if (state.refs.runId.current !== stored.runId
    || readStoredServerRun(projectId)?.runId !== stored.runId) return;
  dropStreamDeltas(projectId);
  clearStoredServerRun(projectId, stored.runId);
  releaseServerRunOwnership(projectId, stored.runId);
  const { refs } = state;
  refs.frozenRun.current = null;
  refs.running.current = false;
  refs.runId.current = null;
  refs.capability.current = null;
  refs.runProject.current = null;
  refs.abort.current = null;
  refs.runExecutor.current = null;
  refs.activeOptions.current = null;
  refs.cursor.current = 0;
  refs.assistantText.current = '';
  refs.assistantThinking.current = '';
  refs.finalizingRun.current = null;
  refs.terminalRun.current = stored.runId;
  state.setLiveTool(null);
  state.setRunning(false);
  state.updateMessages((messages) => {
    const index = messages.findLastIndex((message) => message.reconcile !== undefined || message.paused === true);
    const note = { role: 'note' as const, text: '已结束该任务。草稿与变更记录已保留。' };
    return index < 0 ? [...messages, note]
      : messages.map((message, position) => position === index ? note : message);
  });
}

export function useServerRunFreezeActions(
  projectId: string,
  state: ServerRunState,
): {
  readonly recheckFrozenRun: () => Promise<void>;
  readonly endFrozenRun: () => Promise<void>;
} {
  const recheckFrozenRun = useCallback(() => recheckFrozenServerRun(projectId, state), [projectId, state]);
  const endFrozenRun = useCallback(() => endFrozenServerRun(projectId, state), [projectId, state]);
  return { recheckFrozenRun, endFrozenRun };
}
