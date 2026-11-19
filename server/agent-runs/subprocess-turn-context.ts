import type { ModelMessage } from 'ai';
import { estimateTextTokens, type AgentContextUsage } from '../../src/agent/context-compaction';
import type { ServerCodexTurnInput } from './codex-turn';
import type { ServerSubprocessResume } from './run-recovery-contract';
import { codexTurnHistoryEntry } from './subprocess-turn-history';

/** The immutable base prompt receives each confirmed outcome exactly once. */
export function resumeSubprocessPrompt(resume: ServerSubprocessResume): string {
  const entries = [...resume.completedTools].sort((a, b) => a.opSeq - b.opSeq).map(codexTurnHistoryEntry);
  return [resume.prompt, ...entries.map((entry) => typeof entry.content === 'string'
    ? entry.content : JSON.stringify(entry.content))].join('\n\n');
}

/** Resumed subprocesses preserve context without running compaction again. */
export function prepareSubprocessResume(
  input: ServerCodexTurnInput,
  resume: ServerSubprocessResume,
  tools: readonly unknown[],
): { messages: ModelMessage[]; usage: AgentContextUsage } {
  const messages: ModelMessage[] = [
    ...(resume.messages?.length ? resume.messages : [{ role: 'user' as const, content: resume.prompt }]),
    ...[...resume.completedTools].sort((a, b) => a.opSeq - b.opSeq).map(codexTurnHistoryEntry),
  ];
  const systemTokens = estimateTextTokens(resume.instructions ?? input.instructions);
  const historyTokens = estimateTextTokens(resumeSubprocessPrompt(resume));
  const toolSchemaTokens = estimateTextTokens(JSON.stringify(tools));
  return { messages, usage: {
    inputTokens: systemTokens + historyTokens + toolSchemaTokens,
    contextWindowTokens: input.contextWindowTokens,
    contextWindowEstimated: input.contextWindowEstimated,
    isEstimated: true, modelId: input.model, compacted: false,
    messageCount: messages.length, systemTokens, historyTokens, toolSchemaTokens,
    toolCount: tools.length, requestIndex: resume.requestIndex, attemptIndex: 0,
  } };
}
