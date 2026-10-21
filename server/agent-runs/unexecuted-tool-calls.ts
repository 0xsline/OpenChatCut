import type { FinishReason, ModelMessage, ToolCallPart, ToolResultPart } from 'ai';

/**
 * The AI SDK leaves a step's tool calls unexecuted unless the step finishes with
 * `stop` or `tool-calls` (an output-token cutoff, a content filter, a provider error).
 * Sent back unanswered they fail the next request with MissingToolResultsError, so
 * each one gets an error result the model can read and act on.
 */
export function answerUnexecutedToolCalls(
  responseMessages: readonly ModelMessage[],
  finishReason: FinishReason,
): ModelMessage[] {
  const answered = new Set<string>();
  for (const message of responseMessages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') answered.add(part.toolCallId);
    }
  }
  const unexecuted: ToolCallPart[] = [];
  for (const message of responseMessages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call' && !part.providerExecuted && !answered.has(part.toolCallId)) {
        unexecuted.push(part);
      }
    }
  }
  if (!unexecuted.length) return [...responseMessages];
  const results: ToolResultPart[] = unexecuted.map((call) => ({
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: 'error-text',
      value: `Not run: the response ended with finish reason "${finishReason}" before this tool could execute.`,
    },
  }));
  return [...responseMessages, { role: 'tool', content: results }];
}
