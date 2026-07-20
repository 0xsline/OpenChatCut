import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
  ToolResultPart,
  UserContent,
} from 'ai';
import type { LlmProvider } from './client';

type UnknownRecord = Record<string, unknown>;
type ToolResultOutput = ToolResultPart['output'];

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' ? value as UnknownRecord : null;
}

function textOutput(value: unknown): ToolResultOutput {
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'text', value: JSON.stringify(value ?? null) };
}

function legacyToolOutput(content: unknown): ToolResultOutput {
  if (!Array.isArray(content)) return textOutput(content);
  const value: Array<
    | { type: 'text'; text: string }
    | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string }
  > = [];
  for (const rawPart of content) {
    const part = record(rawPart);
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      value.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      const source = record(part.source);
      if (source?.type === 'base64' && typeof source.data === 'string') {
        value.push({
          type: 'file',
          data: { type: 'data', data: source.data },
          mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/jpeg',
        });
      }
    }
  }
  return value.length ? { type: 'content', value } : textOutput(content);
}

function isAiSdkMessage(message: UnknownRecord): boolean {
  if (message.role === 'tool') return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((rawPart) => {
    const part = record(rawPart);
    return part?.type === 'tool-call'
      || part?.type === 'tool-result'
      || part?.type === 'reasoning'
      || part?.type === 'file';
  });
}

export function normalizeLlmMessages(input: readonly unknown[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const rawMessage of input) {
    const message = record(rawMessage);
    if (!message || typeof message.role !== 'string') continue;

    if (isAiSdkMessage(message)) {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const rawPart of message.content) {
          const part = record(rawPart);
          if (part?.type === 'tool-call'
            && typeof part.toolCallId === 'string'
            && typeof part.toolName === 'string') {
            toolNames.set(part.toolCallId, part.toolName);
          }
        }
      }
      messages.push(message as ModelMessage);
      continue;
    }

    if (message.role === 'system' && typeof message.content === 'string') {
      messages.push({ role: 'system', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const content: AssistantContent = [];
      for (const rawPart of message.content) {
        const part = record(rawPart);
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'tool_use'
          && typeof part.id === 'string'
          && typeof part.name === 'string') {
          toolNames.set(part.id, part.name);
          content.push({
            type: 'tool-call',
            toolCallId: part.id,
            toolName: part.name,
            input: part.input ?? {},
          });
        }
      }
      if (content.length) messages.push({ role: 'assistant', content });
      continue;
    }

    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      messages.push({ role: 'user', content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    const userContent: UserContent = [];
    const toolContent: ToolContent = [];
    for (const rawPart of message.content) {
      const part = record(rawPart);
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        userContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        const source = record(part.source);
        if (source?.type === 'base64' && typeof source.data === 'string') {
          userContent.push({
            type: 'file',
            data: { type: 'data', data: source.data },
            mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/jpeg',
          });
        }
      } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
        toolContent.push({
          type: 'tool-result',
          toolCallId: part.tool_use_id,
          toolName: toolNames.get(part.tool_use_id) ?? 'unknown_tool',
          output: legacyToolOutput(part.content),
        });
      }
    }
    if (userContent.length) messages.push({ role: 'user', content: userContent });
    if (toolContent.length) messages.push({ role: 'tool', content: toolContent });
  }

  return messages;
}

function portableOutput(output: ToolResultOutput): ToolResultOutput {
  if (output.type !== 'content') {
    return withoutProviderOptions(output);
  }
  return {
    type: 'content',
    value: output.value.map(withoutProviderOptions),
  };
}

function withoutProviderOptions<T extends object>(value: T): T {
  const { providerOptions: _providerOptions, ...portable } =
    value as T & { providerOptions?: unknown };
  return portable as T;
}

export function makeMessagesPortable(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === 'system') return [{ role: 'system', content: message.content }];
    if (message.role === 'user') {
      if (typeof message.content === 'string') return [{ role: 'user', content: message.content }];
      return [{
        role: 'user',
        content: message.content.map(withoutProviderOptions),
      }];
    }
    if (message.role === 'assistant') {
      if (typeof message.content === 'string') return [{ role: 'assistant', content: message.content }];
      const content: AssistantContent = [];
      for (const part of message.content) {
        if (part.type === 'reasoning'
          || part.type === 'reasoning-file'
          || part.type === 'custom') continue;
        const portable = withoutProviderOptions(part);
        if (portable.type === 'tool-result') {
          content.push({ ...portable, output: portableOutput(portable.output) });
        } else {
          content.push(portable);
        }
      }
      return content.length ? [{ role: 'assistant', content }] : [];
    }
    return [{
      role: 'tool',
      content: message.content.map((part) => {
        const portable = withoutProviderOptions(part);
        return portable.type === 'tool-result'
          ? { ...portable, output: portableOutput(portable.output) }
          : portable;
      }),
    }];
  });
}

export function prepareMessagesForProvider(
  messages: readonly ModelMessage[],
  sourceProvider: LlmProvider,
  targetProvider: LlmProvider,
): ModelMessage[] {
  if (sourceProvider === targetProvider) return [...messages];
  return makeMessagesPortable(messages);
}
