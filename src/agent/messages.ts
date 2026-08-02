import type {
  AssistantContent,
  ModelMessage,
  ToolContent,
  ToolResultPart,
  UserContent,
} from 'ai';
import type { LlmProvider, OpenAiApiMode } from './providerConfig';

type UnknownRecord = Record<string, unknown>;
type UserContentParts = Exclude<UserContent, string>;
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

const CHAT_MEDIA_INTRO = 'Rendered media returned by the preceding tool calls:';
const CHAT_MEDIA_ATTACHED_FALLBACK = 'Rendered media is attached in the following user message.';
const CHAT_MEDIA_OMITTED_FALLBACK =
  'Rendered media was omitted because the selected model does not accept visual attachments.';
const USER_MEDIA_OMITTED_FALLBACK =
  'Visual attachment omitted because the selected model does not support image input.';

export interface ChatCompletionsMediaPreparation {
  messages: ModelMessage[];
  messagesWithoutMedia: ModelMessage[];
  movedMedia: boolean;
}

function chatToolOutputs(
  output: ToolResultOutput,
  attachments: UserContentParts,
): { withMedia: ToolResultOutput; withoutMedia: ToolResultOutput } | null {
  if (output.type !== 'content') return null;
  const files = output.value.filter((part) => part.type === 'file');
  if (!files.length) return null;
  for (const file of files) {
    attachments.push({
      type: 'file',
      data: file.data,
      mediaType: file.mediaType,
      ...(file.filename ? { filename: file.filename } : {}),
      ...(file.providerOptions ? { providerOptions: file.providerOptions } : {}),
    });
  }
  const textParts = output.value.filter((part) => part.type === 'text');
  const text = textParts.map((part) => part.text).join('\n');
  const providerOptions = textParts.length === 1 && textParts[0]!.providerOptions
    ? { providerOptions: textParts[0]!.providerOptions }
    : {};
  return {
    withMedia: {
      type: 'text',
      value: text || CHAT_MEDIA_ATTACHED_FALLBACK,
      ...providerOptions,
    },
    withoutMedia: {
      type: 'text',
      value: text || CHAT_MEDIA_OMITTED_FALLBACK,
      ...providerOptions,
    },
  };
}

// Chat Completions accepts media as user input, not inside tool results.
// Build the attachment and text-only forms together so callers never inspect
// opaque file bytes to decide whether a safe retry is available.
export function prepareChatCompletionsMediaMessages(
  messages: readonly ModelMessage[],
): ChatCompletionsMediaPreparation {
  const prepared: ModelMessage[] = [];
  const withoutMedia: ModelMessage[] = [];
  let movedMedia = false;
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== 'tool') {
      prepared.push(message);
      withoutMedia.push(message);
      index += 1;
      continue;
    }
    const attachments: UserContentParts = [];
    while (index < messages.length && messages[index]!.role === 'tool') {
      const toolMessage = messages[index] as Extract<ModelMessage, { role: 'tool' }>;
      let changed = false;
      const withMediaContent: ToolContent = [];
      const withoutMediaContent: ToolContent = [];
      for (const part of toolMessage.content) {
        if (part.type !== 'tool-result') {
          withMediaContent.push(part);
          withoutMediaContent.push(part);
          continue;
        }
        const outputs = chatToolOutputs(part.output, attachments);
        if (!outputs) {
          withMediaContent.push(part);
          withoutMediaContent.push(part);
          continue;
        }
        changed = true;
        movedMedia = true;
        withMediaContent.push({ ...part, output: outputs.withMedia });
        withoutMediaContent.push({ ...part, output: outputs.withoutMedia });
      }
      prepared.push(changed ? { ...toolMessage, content: withMediaContent } : toolMessage);
      withoutMedia.push(changed ? { ...toolMessage, content: withoutMediaContent } : toolMessage);
      index += 1;
    }
    if (attachments.length) {
      prepared.push({
        role: 'user',
        content: [{ type: 'text', text: CHAT_MEDIA_INTRO }, ...attachments],
      });
    }
  }
  return { messages: prepared, messagesWithoutMedia: withoutMedia, movedMedia };
}

export function withoutModelImages(messages: readonly ModelMessage[]): ModelMessage[] {
  return prepareChatCompletionsMediaMessages(messages).messagesWithoutMedia.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    let removed = false;
    const content = message.content.filter((part) => {
      const value = record(part);
      const isImage = value?.type === 'image'
        || (value?.type === 'file'
          && typeof value.mediaType === 'string'
          && value.mediaType.toLowerCase().startsWith('image/'));
      removed ||= isImage;
      return !isImage;
    });
    if (!removed) return message;
    return {
      ...message,
      content: [...content, { type: 'text', text: USER_MEDIA_OMITTED_FALLBACK }],
    } as ModelMessage;
  });
}

export function makeMessagesPortable(
  messages: readonly ModelMessage[],
  openAiApiMode?: OpenAiApiMode,
): ModelMessage[] {
  const portable = messages.flatMap((message): ModelMessage[] => {
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
        const portablePart = withoutProviderOptions(part);
        if (portablePart.type === 'tool-result') {
          content.push({ ...portablePart, output: portableOutput(portablePart.output) });
        } else {
          content.push(portablePart);
        }
      }
      return content.length ? [{ role: 'assistant', content }] : [];
    }
    return [{
      role: 'tool',
      content: message.content.map((part) => {
        const portablePart = withoutProviderOptions(part);
        return portablePart.type === 'tool-result'
          ? { ...portablePart, output: portableOutput(portablePart.output) }
          : portablePart;
      }),
    }];
  });
  return openAiApiMode === 'chat'
    ? prepareChatCompletionsMediaMessages(portable).messages
    : portable;
}

export function prepareMessagesForProvider(
  messages: readonly ModelMessage[],
  sourceProvider: LlmProvider,
  targetProvider: LlmProvider,
): ModelMessage[] {
  if (sourceProvider === targetProvider) return [...messages];
  return makeMessagesPortable(messages);
}
