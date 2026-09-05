import type { ModelMessage } from 'ai';

const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1;
export const MODEL_MEDIA_TOKEN_ESTIMATE = 1_200;
const SUMMARY_VALUE_MAX_CHARS = 12_000;

export type ContentPart = {
  readonly type?: unknown;
  readonly toolCallId?: unknown;
  readonly text?: unknown;
  readonly toolName?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
};

export function safeJson(value: unknown): string {
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

export function contentTokens(content: unknown): number {
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
