import { estimateTextTokens } from '../context-compaction';
import { runCodexTurn } from './client';

export interface CodexSummaryRequest {
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export async function runCodexSummary(request: CodexSummaryRequest): Promise<string> {
  let text = '';
  let done = false;
  await runCodexTurn({
    requestId: crypto.randomUUID(),
    system: request.system,
    prompt: request.prompt,
    projectId: request.projectId,
    tools: [],
    askOnly: true,
    ...(request.model?.trim() ? { model: request.model.trim() } : {}),
    reasoningEffort: request.reasoningEffort?.trim() || null,
  }, (event) => {
    if (event.type === 'text-delta') {
      const candidate = text + event.delta;
      if (estimateTextTokens(candidate) > request.maxOutputTokens) {
        throw new Error('Codex context summary exceeded its output limit.');
      }
      text = candidate;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    } else if (event.type === 'done') {
      done = true;
    }
  }, request.signal);
  if (!done) throw new Error('Codex context summary ended before completion.');
  return text.trim();
}
