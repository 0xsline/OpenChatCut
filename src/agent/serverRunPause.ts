import type { DisplayMessage } from './agent-session';
import type { ServerRunState } from './serverRunState';
import { patchStoredServerRun, type StoredServerRun } from './serverRunSessionStorage';
import { releaseServerRunOwnership } from './serverRunOwnership';

export const PAUSED_RUN_NOTICE = '上次任务暂停，发送消息继续。也可以先结束任务，再开始新任务。';

/** Pause retains the draft and capability; only an explicit instruction starts another attempt. */
export function pauseBrowserServerRun(projectId: string, state: ServerRunState, error?: string): void {
  const runId = state.refs.runId.current;
  if (!runId) return;
  state.eventSession.close();
  state.toolExecutor.stop();
  if (!patchStoredServerRun(projectId, { paused: true })) {
    state.appendMessage({ role: 'error', text: '暂停状态保存失败，恢复凭据已保留。请刷新后重试。' });
    state.refs.running.current = true;
    state.setRunning(false);
    return;
  }
  state.refs.frozenRun.current = null;
  state.refs.running.current = false;
  state.setRunning(false);
  state.setLiveTool(null);
  state.updateMessages((messages) => {
    const card: DisplayMessage = { role: 'error', paused: true,
      text: `${PAUSED_RUN_NOTICE}${error ? `\n${error}` : ''}` };
    const index = messages.findLastIndex((message) => message.paused === true);
    return index < 0 ? [...messages, card]
      : messages.map((message, position) => position === index ? card : message);
  });
  releaseServerRunOwnership(projectId, runId);
}

/** Reconstruct each accepted/pending user instruction exactly once after hydration. */
export function restoreContinuationMessages(messages: DisplayMessage[], stored: StoredServerRun): DisplayMessage[] {
  let result = messages;
  const turns = stored.continuationTurns ?? [];
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    const position = result.findIndex((message) => message.continuationId === turn.id && message.role === 'user');
    const assistantText = turns[index + 1]?.previousAssistantText ?? stored.assistantText ?? '';
    if (position < 0) result = [...result, { role: 'user', text: turn.text, continuationId: turn.id },
      { role: 'assistant', text: assistantText }];
    else {
      const nextUser = result.findIndex((message, offset) => offset > position && message.role === 'user');
      const assistant = result.findIndex((message, offset) => offset > position
        && (nextUser < 0 || offset < nextUser) && message.role === 'assistant');
      if (assistant >= 0) result = result.map((message, offset) => offset === assistant
        ? { ...message, text: assistantText } : message);
    }
  }
  return result;
}
