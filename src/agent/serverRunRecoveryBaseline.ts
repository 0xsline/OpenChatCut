import { serverRunResumeCursor, type ServerRunMetadata } from './serverRunProtocol';
import { patchStoredServerRun, readStoredServerRun } from './serverRunSessionStorage';
import { dropStreamDeltas } from './serverRunStreamDeltaBuffer';
import type { ServerRunState } from './serverRunState';

/** Install text and cursor together; skipped SSE deltas cannot supply either. */
export function adoptServerRunBaseline(
  projectId: string,
  state: ServerRunState,
  metadata: ServerRunMetadata,
  storedCursor: number,
): ReturnType<typeof serverRunResumeCursor> {
  const adoption = serverRunResumeCursor(metadata, storedCursor);
  if (!adoption.adoptedBaseline) return adoption;
  const text = metadata.recovery?.replayBase?.terminalText ?? '';
  const stored = readStoredServerRun(projectId);
  dropStreamDeltas(projectId);
  if (!patchStoredServerRun(projectId, {
    cursor: adoption.cursor, assistantText: text, assistantThinking: '',
  })) throw new Error('Browser durable storage could not persist recovery baseline.');
  state.refs.cursor.current = adoption.cursor;
  state.refs.assistantText.current = text;
  state.refs.assistantThinking.current = '';
  state.updateMessages((messages) => {
    const user = messages.findLastIndex((message) => message.role === 'user');
    if (user < 0 || messages[user]?.text !== stored?.text) return messages;
    const assistant = messages.findLastIndex((message, index) => index > user && message.role === 'assistant');
    if (assistant < 0) return [...messages, { role: 'assistant', text }];
    return messages.map((message, index) => index === assistant
      ? { ...message, text, thinking: undefined } : message);
  });
  return adoption;
}
