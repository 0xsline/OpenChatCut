import type { ModelMessage } from 'ai';
import { activatedToolNamesFromResult, activationProviderOptions } from '../tool-activation';
import { compactToolResultForModel } from '../tool-result-compaction';

interface ToolEvent {
  readonly name: string;
  readonly args: unknown;
}

interface ToolExecution {
  readonly success: boolean;
  readonly result: unknown;
}

export function codexToolInput(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '[unserializable tool input]';
  }
}

function resultForHistory(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.__images)) return result;
  const { __images, ...rest } = record;
  return { ...rest, __images: `[${__images.length} image payloads omitted]` };
}

export function codexToolHistoryEntry(
  event: ToolEvent,
  execution: ToolExecution,
): ModelMessage {
  const text = [
    `[tool call: ${event.name}] ${codexToolInput(event.args)}`,
    `[tool result: ${event.name}; success=${execution.success}] ${codexToolInput(compactToolResultForModel(resultForHistory(execution.result)))}`,
  ].join('\n');
  const providerOptions = event.name === 'ToolSearch'
    ? activationProviderOptions(activatedToolNamesFromResult(execution.result))
    : undefined;
  return providerOptions
    ? { role: 'assistant', content: [{ type: 'text', text, providerOptions }] }
    : { role: 'assistant', content: text };
}
