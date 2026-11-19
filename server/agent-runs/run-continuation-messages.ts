import type { ModelMessage } from 'ai';
import type { RunRecoveryRun } from './run-recovery-store-records';

type ToolOutput = Extract<Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-result' }>['output'];

/** Complete only the interrupted request's confirmed calls, then add the user's next instruction. */
export function buildRunContinuationMessages(run: RunRecoveryRun, message: string): ModelMessage[] {
  const messages: ModelMessage[] = [...(run.messages ?? run.executionInput?.messages ?? [])];
  if (run.requestState === 'inflight') {
    const outcomes = run.tools.filter((tool) => tool.state === 'outcome'
      && tool.requestIndex === run.requestIndex && tool.opSeq > run.requestOpBoundary);
    if (outcomes.length) {
      messages.push({ role: 'assistant', content: outcomes.map((tool) => ({
        type: 'tool-call', toolCallId: tool.toolCallId, toolName: tool.name, input: tool.args ?? {},
      })) });
      messages.push({ role: 'tool', content: outcomes.map((tool) => ({
        type: 'tool-result', toolCallId: tool.toolCallId, toolName: tool.name,
        output: { type: tool.success ? 'json' : 'error-json', value: tool.result ?? null } as ToolOutput,
      })) });
    }
  }
  messages.push({ role: 'user', content: message });
  return messages;
}
