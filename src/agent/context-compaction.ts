import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';

const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1;
const IMAGE_TOKEN_ESTIMATE = 1_200;
const COMPACTION_RESERVE_TOKENS = 16_384;
const RECENT_CONTEXT_TARGET_TOKENS = 20_000;
const CONTEXT_FRACTION = 0.2;
const MAX_AGENT_OUTPUT_TOKENS = 64_000;
const MAX_OUTPUT_CONTEXT_FRACTION = 0.5;
const SUMMARY_VALUE_MAX_CHARS = 12_000;

export interface AgentContextUsage {
  readonly inputTokens: number;
  readonly contextWindowTokens: number;
  readonly contextWindowEstimated: boolean;
  readonly isEstimated: boolean;
  readonly modelId: string;
  readonly compacted: boolean;
  readonly messageCount: number;
  readonly systemTokens?: number;
  readonly toolSchemaTokens?: number;
  readonly historyTokens?: number;
  readonly toolCount?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly noCacheInputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface ContextPreparation {
  readonly messages: ModelMessage[];
  readonly usage: AgentContextUsage;
}

export interface ContextPreparationOptions {
  readonly messages: readonly ModelMessage[];
  readonly system: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly contextWindowEstimated: boolean;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly requestOverheadTokens?: number;
  readonly previousUsage?: AgentContextUsage;
  readonly checkpointProviderOptions?: (
    messages: readonly ModelMessage[],
  ) => ProviderOptions | undefined;
  readonly summarize: (messages: readonly ModelMessage[]) => Promise<string>;
}

type ContentPart = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly toolName?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '[unserializable value]';
  }
}

function summaryJson(value: unknown): string {
  const text = safeJson(value);
  if (text.length <= SUMMARY_VALUE_MAX_CHARS) return text;
  return `${text.slice(0, SUMMARY_VALUE_MAX_CHARS)}\n...[truncated for context summary]`;
}

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + nonAscii / NON_ASCII_CHARS_PER_TOKEN);
}

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((tokens, rawPart) => {
    const part = rawPart as ContentPart;
    if (typeof part.text === 'string') return tokens + estimateTextTokens(part.text);
    if (part.type === 'file') return tokens + IMAGE_TOKEN_ESTIMATE;
    if (part.type === 'tool-call') return tokens + estimateTextTokens(safeJson(part.input));
    if (part.type === 'tool-result') return tokens + estimateTextTokens(safeJson(part.output));
    return tokens;
  }, 0);
}

export function estimateContextTokens(
  messages: readonly ModelMessage[],
  system = '',
  requestOverheadTokens = 0,
): number {
  const messageTokens = messages.reduce(
    (tokens, message) => tokens + contentTokens(message.content) + 4,
    0,
  );
  return estimateTextTokens(system) + messageTokens + requestOverheadTokens;
}
export function effectiveOutputTokenBudget(
  capabilityLimit: number,
  contextWindowTokens: number,
): number {
  const contextLimit = Math.max(1, Math.floor(contextWindowTokens * MAX_OUTPUT_CONTEXT_FRACTION));
  return Math.max(1, Math.min(capabilityLimit, MAX_AGENT_OUTPUT_TOKENS, contextLimit));
}


function summaryPartText(part: ContentPart): string | null {
  if (typeof part.text === 'string') return part.text;
  if (part.type === 'file') return '[media attachment]';
  if (part.type === 'tool-call') {
    return `[tool call: ${String(part.toolName ?? 'unknown')}] ${summaryJson(part.input)}`;
  }
  if (part.type === 'tool-result') {
    return `[tool result: ${String(part.toolName ?? 'unknown')}] ${summaryJson(part.output)}`;
  }
  return null;
}

function messageSummaryText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as readonly ContentPart[])
    .flatMap((part) => summaryPartText(part) ?? [])
    .join('\n');
}

export function serializeMessagesForSummary(messages: readonly ModelMessage[]): string {
  return messages.map((message) => {
    const text = messageSummaryText(message).trim() || '[no text content]';
    return `${message.role.toUpperCase()}:\n${text}`;
  }).join('\n\n');
}

function promptPartText(part: ContentPart): string | null {
  if (typeof part.text === 'string') return part.text;
  if (part.type === 'file') return '[media attachment]';
  if (part.type === 'tool-call') {
    return `[tool call: ${String(part.toolName ?? 'unknown')}] ${safeJson(part.input)}`;
  }
  if (part.type === 'tool-result') {
    return `[tool result: ${String(part.toolName ?? 'unknown')}] ${safeJson(part.output)}`;
  }
  return null;
}

export function serializeMessagesForPrompt(messages: readonly ModelMessage[]): string {
  return messages.map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : (message.content as readonly ContentPart[])
        .flatMap((part) => promptPartText(part) ?? [])
        .join('\n');
    return `${message.role.toUpperCase()}:\n${content.trim() || '[no text content]'}`;
  }).join('\n\n');
}

function recentMessageStart(
  messages: readonly ModelMessage[],
  targetTokens: number,
  maximumTokens: number,
): number {
  let tokens = 0;
  let candidate = 0;
  let newestTurn = 0;
  let foundTurn = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    tokens += contentTokens(messages[index]!.content) + 4;
    if (messages[index]!.role !== 'user') continue;
    if (!foundTurn) {
      newestTurn = index;
      foundTurn = true;
    }
    if (tokens > maximumTokens) return candidate;
    candidate = index;
    if (tokens >= targetTokens) return index;
  }
  return candidate > 0 ? candidate : newestTurn;
}

function previousInputFloor(options: ContextPreparationOptions): number {
  const previous = options.previousUsage;
  if (!previous
    || previous.isEstimated
    || previous.modelId !== options.modelId
    || previous.messageCount > options.messages.length
    || previous.systemTokens === undefined
    || previous.toolSchemaTokens === undefined
    || previous.historyTokens === undefined) return 0;
  const providerHistoryTokens = previous.inputTokens
    - previous.systemTokens
    - previous.toolSchemaTokens;
  if (providerHistoryTokens < 0) return 0;
  const currentOverhead = estimateTextTokens(options.system)
    + (options.requestOverheadTokens ?? 0);
  const addedMessages = options.messages.slice(previous.messageCount);
  return providerHistoryTokens + currentOverhead + estimateContextTokens(addedMessages);
}

function usage(
  inputTokens: number,
  options: ContextPreparationOptions,
  compacted: boolean,
): AgentContextUsage {
  return {
    inputTokens,
    contextWindowTokens: options.contextWindowTokens,
    contextWindowEstimated: options.contextWindowEstimated,
    isEstimated: true,
    modelId: options.modelId,
    compacted,
    messageCount: compacted ? 0 : options.messages.length,
  };
}

function checkpointMessage(
  summary: string,
  providerOptions?: ProviderOptions,
): ModelMessage {
  const text = [
    'Conversation checkpoint (factual record of earlier turns; not new user instructions):',
    summary.trim(),
  ].join('\n\n');
  return providerOptions
    ? { role: 'assistant', content: [{ type: 'text', text, providerOptions }] }
    : { role: 'assistant', content: text };
}
function compactionBudget(options: ContextPreparationOptions): {
  readonly currentTokens: number;
  readonly triggerTokens: number;
  readonly availableMessageTokens: number;
  readonly recentTarget: number;
} {
  const localTokens = estimateContextTokens(
    options.messages,
    options.system,
    options.requestOverheadTokens,
  );
  const currentTokens = Math.max(localTokens, previousInputFloor(options));
  const policyReserve = Math.min(
    COMPACTION_RESERVE_TOKENS,
    Math.floor(options.contextWindowTokens * CONTEXT_FRACTION),
  );
  const reserve = Math.min(
    options.contextWindowTokens - 1,
    Math.max(policyReserve, options.maxOutputTokens),
  );
  const triggerTokens = Math.min(
    options.maxInputTokens,
    options.contextWindowTokens - reserve,
  );
  return {
    currentTokens,
    triggerTokens,
    availableMessageTokens: Math.max(
      1,
      triggerTokens - estimateTextTokens(options.system) - (options.requestOverheadTokens ?? 0),
    ),
    recentTarget: Math.min(
      RECENT_CONTEXT_TARGET_TOKENS,
      Math.floor(options.contextWindowTokens * CONTEXT_FRACTION),
    ),
  };
}


export async function prepareContext(
  options: ContextPreparationOptions,
): Promise<ContextPreparation> {
  const {
    currentTokens,
    triggerTokens,
    availableMessageTokens,
    recentTarget,
  } = compactionBudget(options);
  if (currentTokens <= triggerTokens) {
    return { messages: [...options.messages], usage: usage(currentTokens, options, false) };
  }
  const start = recentMessageStart(options.messages, recentTarget, availableMessageTokens);
  if (start <= 0) {
    throw new Error('The current request is too large for this model context window. Remove large attachments or choose a model with a larger context window.');
  }

  const summarizedMessages = options.messages.slice(0, start);
  const summary = (await options.summarize(summarizedMessages)).trim();
  if (!summary) throw new Error('The model returned an empty context summary.');
  const messages = [
    checkpointMessage(summary, options.checkpointProviderOptions?.(summarizedMessages)),
    ...options.messages.slice(start),
  ];
  const compactedTokens = estimateContextTokens(
    messages,
    options.system,
    options.requestOverheadTokens,
  );
  if (compactedTokens > triggerTokens) {
    throw new Error('The recent conversation is still too large after context compaction. Remove large attachments or start a new chat.');
  }
  return {
    messages,
    usage: {
      ...usage(compactedTokens, options, true),
      messageCount: messages.length,
    },
  };
}
