import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { redactTextForAgentRuntime } from './runtime-artifact';
import {
  formatContextCheckpointMessage,
  type ContextCheckpointLinkage,
} from './context-checkpoint';
export {
  ContextIntegrityError,
  parseContextCheckpointMarker,
  verifyCanonicalContextCheckpoint,
  verifyContextCheckpointMarker,
} from './context-checkpoint';
export type {
  ContextCheckpointLinkage,
  ContextCheckpointMarker,
  ContextCheckpointSourceArtifact,
  PersistedContextCheckpoint,
} from './context-checkpoint';

const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1;
export const MODEL_MEDIA_TOKEN_ESTIMATE = 1_200;
const COMPACTION_RESERVE_TOKENS = 16_384;
const RECENT_CONTEXT_TARGET_TOKENS = 20_000;
const DEFAULT_COMPACTION_TRIGGER_FRACTION = 0.7;
const CACHE_FRIENDLY_TRIGGER_FRACTION = 0.8;
const CACHE_MISS_TRIGGER_FRACTION = 0.65;
const CONTEXT_FRACTION = 0.2;
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
  readonly cacheTtlMs?: number;
  readonly requestIndex?: number;
  readonly attemptIndex?: number;
  readonly retryCount?: number;
  readonly retryReasons?: readonly string[];
  readonly mediaInputCount?: number;
  readonly mediaTokenEstimate?: number;
}

/** Ephemeral preparation-only record; sourceText must never enter saved chat JSON. */
export interface AgentContextCheckpoint extends ContextCheckpointLinkage {
  readonly summary: string;
  /**
   * Sanitized source used to create sourceDigest. Runtime must archive it
   * out-of-band, replace it with sourceArtifactId, then discard this field.
   */
  readonly sourceText: string;
  readonly sourceMessageCount: number;
  /** Creation-time provenance; replay validation requires the archived sourceText. */
  readonly createdAt: number;
  /** Model and window used when this checkpoint was produced. */
  readonly modelId?: string;
  readonly contextWindowTokens?: number;
}


export interface ContextPreparation {
  readonly messages: ModelMessage[];
  readonly usage: AgentContextUsage;
  readonly checkpoint?: AgentContextCheckpoint;
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
  /** Skip the pressure fast-path and compact even when estimates are under the trigger. */
  readonly forceCompact?: boolean;
  readonly checkpointProviderOptions?: (
    messages: readonly ModelMessage[],
  ) => ProviderOptions | undefined;
  readonly summarize: (messages: readonly ModelMessage[]) => Promise<string>;
}

type ContentPart = {
  readonly type?: unknown;
  readonly toolCallId?: unknown;
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
    if (part.type === 'file') return tokens + MODEL_MEDIA_TOKEN_ESTIMATE;
    if (part.type === 'tool-call') return tokens + estimateTextTokens(safeJson(part.input));
    if (part.type === 'tool-result') return tokens + estimateTextTokens(safeJson(part.output));
    return tokens;
  }, 0);
}
export function countContextMedia(messages: readonly ModelMessage[]): number {
  return messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) return count;
    return count + message.content.filter((part) =>
      part.type === 'file' || part.type === 'image').length;
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
export interface ActiveModelRoundBudgetInput {
  readonly messages: readonly ModelMessage[];
  readonly system: string;
  readonly toolSchemas: readonly unknown[];
  readonly contextWindowTokens: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/** Input room left for the next tool result in this exact provider request shape. */
export function remainingInputBudgetTokens(input: ActiveModelRoundBudgetInput): number {
  const outputReservedCeiling = Math.max(0, input.contextWindowTokens - input.maxOutputTokens);
  const inputCeiling = Math.min(input.maxInputTokens, outputReservedCeiling);
  const schemaTokens = estimateTextTokens(JSON.stringify(input.toolSchemas));
  const occupied = estimateContextTokens(input.messages, input.system, schemaTokens);
  return Math.max(0, inputCeiling - occupied);
}
/**
 * Output token budget for the currently selected provider/model. No fixed
 * ceiling here: the budget follows the model's own maxOutputTokens
 * (capabilityLimit) and is only bounded by reserving half the context window
 * for the reply (so the model never tries to stream more than half its input
 * window). Removing the previous hard 64k cap lets e.g. a 128k/256k-output
 * model actually emit that much instead of being truncated.
 */
export function effectiveOutputTokenBudget(
  capabilityLimit: number,
  contextWindowTokens: number,
): number {
  const contextLimit = Math.max(1, Math.floor(contextWindowTokens * MAX_OUTPUT_CONTEXT_FRACTION));
  return Math.max(1, Math.min(capabilityLimit, contextLimit));
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

const IDENTIFIER_PATTERN = /\b(?:operationId|assetId|itemId|clipId|trackId|jobId|proposalId|editSessionId|toolCallId)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._:/-]{3,160})/gi;
const MEDIA_PATH_PATTERN = /\/media\/uploads\/[A-Za-z0-9._%/-]+/g;

function deterministicCheckpointEvidence(
  summary: string,
  messages: readonly ModelMessage[],
  sourceText: string,
): string {
  const evidence = new Set<string>();
  for (const match of sourceText.matchAll(IDENTIFIER_PATTERN)) {
    const value = match[0].trim().slice(0, 200);
    if (!summary.includes(value)) evidence.add(value);
    if (evidence.size >= 64) break;
  }
  for (const match of sourceText.matchAll(MEDIA_PATH_PATTERN)) {
    if (!summary.includes(match[0])) evidence.add(match[0]);
    if (evidence.size >= 64) break;
  }
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as readonly ContentPart[]) {
      if (part.type !== 'tool-call' && part.type !== 'tool-result') continue;
      const callId = typeof part.toolCallId === 'string' ? part.toolCallId : '';
      if (!callId || summary.includes(callId)) continue;
      evidence.add(`${String(part.toolName ?? 'unknown')} toolCallId=${callId}`.slice(0, 200));
      if (evidence.size >= 64) break;
    }
    if (evidence.size >= 64) break;
  }
  return evidence.size
    ? `${summary}\n\n### Deterministically retained identifiers\n${[...evidence].map((value) => `- ${value}`).join('\n')}`
    : summary;
}
async function sha256Text(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('The current environment cannot create a secure context checkpoint digest.');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** SHA-256 of the exact sanitized summary transcript used for compaction provenance. */
export async function sourceMessagesDigest(
  messages: readonly ModelMessage[],
): Promise<string> {
  return sha256Text(redactTextForAgentRuntime(serializeMessagesForSummary(messages)));
}
async function createCheckpoint(
  summary: string,
  sourceText: string,
  sourceMessageCount: number,
): Promise<AgentContextCheckpoint> {
  const sanitizedSummary = redactTextForAgentRuntime(summary);
  const sanitizedSourceText = redactTextForAgentRuntime(sourceText);
  const [sourceDigest, summaryDigest] = await Promise.all([
    sha256Text(sanitizedSourceText),
    sha256Text(sanitizedSummary),
  ]);
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('The current environment cannot create a unique context checkpoint id.');
  }
  return {
    summary: sanitizedSummary,
    checkpointId: globalThis.crypto.randomUUID(),
    sourceText: sanitizedSourceText,
    sourceMessageCount,
    sourceDigest,
    summaryDigest,
    createdAt: Date.now(),
  };
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
function compactionTriggerFraction(previous?: AgentContextUsage): number {
  if (!previous?.inputTokens) return DEFAULT_COMPACTION_TRIGGER_FRACTION;
  const cacheReadRatio = (previous.cacheReadTokens ?? 0) / previous.inputTokens;
  if (cacheReadRatio >= 0.8) return CACHE_FRIENDLY_TRIGGER_FRACTION;
  const noCacheRatio = (previous.noCacheInputTokens ?? 0) / previous.inputTokens;
  return noCacheRatio >= 0.7
    ? CACHE_MISS_TRIGGER_FRACTION
    : DEFAULT_COMPACTION_TRIGGER_FRACTION;
}


function checkpointMessage(
  checkpoint: AgentContextCheckpoint,
  providerOptions?: ProviderOptions,
): ModelMessage {
  const text = formatContextCheckpointMessage(checkpoint.summary, checkpoint);
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
    Math.floor(options.contextWindowTokens * compactionTriggerFraction(options.previousUsage)),
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
  if (currentTokens <= triggerTokens && !options.forceCompact) {
    return { messages: [...options.messages], usage: usage(currentTokens, options, false) };
  }
  const start = recentMessageStart(options.messages, recentTarget, availableMessageTokens);
  if (start <= 0) {
    throw new Error('The current request is too large for this model context window. Remove large attachments or choose a model with a larger context window.');
  }

  const summarizedMessages = options.messages.slice(0, start);
  const sourceText = serializeMessagesForSummary(summarizedMessages);
  const generatedSummary = (await options.summarize(summarizedMessages)).trim();
  if (!generatedSummary) throw new Error('The model returned an empty context summary.');
  const summary = deterministicCheckpointEvidence(
    generatedSummary,
    summarizedMessages,
    sourceText,
  );
  const checkpoint = {
    ...(await createCheckpoint(summary, sourceText, summarizedMessages.length)),
    modelId: options.modelId,
    contextWindowTokens: options.contextWindowTokens,
  };
  const messages = [
    checkpointMessage(checkpoint, options.checkpointProviderOptions?.(summarizedMessages)),
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
    checkpoint,
  };
}
