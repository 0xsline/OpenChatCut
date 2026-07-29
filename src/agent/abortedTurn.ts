// The session ending judgment after a round of abort is separated into a file so that it can be directly imported by the Node verification script.
// (runtime.ts will also pull in the entire tool graph, which contains resources such as GLSL that Node cannot load).
import type { ModelMessage } from 'ai';

/** Tool calls that have been issued in the session but have no results yet (used to make up for the ending when aborted). exported for verify. */
export function unresolvedToolCalls(
  messages: readonly ModelMessage[],
): Array<{ toolCallId: string; toolName: string }> {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') pending.set(part.toolCallId, part.toolName);
      else if (part.type === 'tool-result') pending.delete(part.toolCallId);
    }
  }
  return [...pending].map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
}

/** Retain the model message that has been received, and add a result that can continue the conversation to the tool call that was suspended when it was suspended. */
export function completeAbortedTurn(
  history: readonly ModelMessage[],
  responseMessages: readonly ModelMessage[],
): ModelMessage[] {
  const messages = [...history, ...responseMessages];
  const pending = unresolvedToolCalls(messages);
  if (!pending.length) return messages;
  return [...messages, {
    role: 'tool',
    content: pending.map(({ toolCallId, toolName }) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output: { type: 'execution-denied' as const, reason: 'Stopped by the user before this tool finished.' },
    })),
  } as ModelMessage];
}
