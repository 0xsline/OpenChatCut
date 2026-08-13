import type { AgentRuntimeModule, LLMMessage } from './runtime';
import type { AgentReference } from './context';
import { getLocale } from '../i18n/locale';

export interface AgentRetryOptions {
  readonly askOnly?: boolean;
  readonly references?: AgentReference[];
}

export interface AgentRetry extends AgentRetryOptions {
  readonly text: string;
}

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'continue';
  text: string;
  thinking?: string;
  retry?: AgentRetry;
  tool?: { name: string; args: unknown; result: unknown };
}

export function createAgentRetry(
  text: string,
  options: AgentRetryOptions = {},
): AgentRetry | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return {
    text: trimmed,
    ...(options.askOnly ? { askOnly: true } : {}),
    ...(options.references?.length ? { references: [...options.references] } : {}),
  };
}

/** Backfill retry metadata for chats persisted before retry support existed. */
export function ensureAgentRetryMetadata(messages: readonly DisplayMessage[]): DisplayMessage[] {
  return messages.map((message) => message.role !== 'user' || message.retry
    ? message
    : { ...message, retry: createAgentRetry(message.text) });
}


export interface LiveTool {
  name: string;
  partial: string;
}
// Deliberate lazy boundary: loading the chat shell must not eagerly load the AI SDK/runtime.

const importAgentRuntime = async (): Promise<AgentRuntimeModule> => import('./runtime');
let agentRuntimePromise: Promise<AgentRuntimeModule> | null = null;

export function preloadAgentRuntime(): Promise<AgentRuntimeModule> {
  if (!agentRuntimePromise) {
    agentRuntimePromise = importAgentRuntime().catch((error: unknown) => {
      agentRuntimePromise = null;
      throw error;
    });
  }
  return agentRuntimePromise;
}

export function initialAgentMessages(): LLMMessage[] {
  return [];
}

export async function enhanceAgentPrompt(draft: string): Promise<string> {
  const trimmed = draft.trim();
  if (!trimmed) return draft;
  try {
    // Deliberate lazy boundary: the prompt enhancer must not load provider SDKs before first use.
    const { generateAgentText } = await import('./client');
    const language = getLocale() === 'zh' ? 'Chinese' : 'English';
    const output = (await generateAgentText({
      maxOutputTokens: 400,
      system: `You improve rough or conversational video-editing requests into one clear, specific, directly executable instruction. Write the instruction in ${language}, matching the selected interface language. Output only the rewritten instruction without explanation, quotation marks, or line breaks.`,
      prompt: trimmed,
    })).trim();
    return output || draft;
  } catch {
    return draft;
  }
}

export function appendRejectedProposal(messages: readonly LLMMessage[]): LLMMessage[] {
  return [...messages, {
    role: 'user',
    content: [
      'User clicked Deny and rejected this generation task. They may want adjustments; do not retry automatically.',
      '（用户拒绝了上述提案，未应用任何改动。不要自动重试生成。）',
    ].join('\n'),
  }];
}
