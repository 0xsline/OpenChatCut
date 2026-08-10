import { jsonSchema, streamText, tool, type LanguageModel, type ModelMessage } from 'ai';
import { normalizeLlmProvider, type LlmProvider } from '../../shared/llm-providers';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { pushRunEvent, setRunStatus, waitForToolResult, type ServerRun } from './store';

/**
 * Provider factory mirroring src/agent/client.ts, but resolved server-side and
 * pointed at the local /llm proxy so key injection, provider routing and
 * error mapping stay identical to the browser path. The proxy routes by the
 * `x-openchatcut-provider` header (keystore holds the real key).
 */
function proxyOptions(provider: LlmProvider, origin: string): {
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
} {
  return {
    baseURL: `${origin}/llm`,
    apiKey: 'proxy-injects-the-real-key',
    headers: { 'x-openchatcut-provider': provider },
  };
}

async function providerFactory(
  provider: LlmProvider,
  origin: string,
): Promise<(modelId: string) => LanguageModel> {
  const options = proxyOptions(provider, origin);
  switch (provider) {
    case 'anthropic':
      return (await import('@ai-sdk/anthropic')).createAnthropic(options);
    case 'gemini':
      return (await import('@ai-sdk/google')).createGoogleGenerativeAI(options);
    case 'kimi':
      return (await import('@ai-sdk/moonshotai')).createMoonshotAI(options);
    case 'qwen':
      return (await import('@ai-sdk/alibaba')).createAlibaba(options);
    case 'deepseek':
      return (await import('@ai-sdk/deepseek')).createDeepSeek(options);
    case 'mistral':
      return (await import('@ai-sdk/mistral')).createMistral(options);
    default: {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      return createOpenAICompatible({ name: provider, ...options });
    }
  }
}

/**
 * Phase A: minimal durable run loop. Streams the assistant reply through the
 * local /llm proxy and publishes text/status events on the run. Tool
 * execution lands in Phase B; the event vocabulary mirrors the browser
 * runtime (text-start / text-delta / text-end / error) so the existing
 * message UI can consume it unchanged.
 */
export async function executeRun(
  run: ServerRun,
  input: {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    provider: string;
    origin: string;
    tools: readonly AgentToolSchema[];
  },
): Promise<void> {
  const abort = new AbortController();
  run.abort = abort;
  setRunStatus(run, 'running');
  pushRunEvent(run, 'text-start', {});
  try {
    const provider = normalizeLlmProvider(input.provider);
    const factory = await providerFactory(provider, input.origin);
    const model = factory(run.model);
    const tools = Object.fromEntries(input.tools.map((schema) => [schema.name, tool({
      description: schema.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
      ),
      execute: async (
        args: Record<string, unknown>,
        options: { toolCallId: string },
      ): Promise<unknown> => {
        pushRunEvent(run, 'tool-request', {
          toolCallId: options.toolCallId,
          name: schema.name,
          args,
        });
        return waitForToolResult(run, options.toolCallId);
      },
    })]));
    let messages: ModelMessage[] = [
      ...input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];
    let text = '';
    const MAX_TOOL_TURNS = 8;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const result = streamText({
        model,
        messages,
        tools,
        maxOutputTokens: 4_096,
        maxRetries: 0,
        abortSignal: abort.signal,
      });
      for await (const delta of result.textStream) {
        text += delta;
        pushRunEvent(run, 'text-delta', { text: delta });
      }
      const stepMessages = await result.responseMessages;
      if (stepMessages.some((m) => m.role === 'tool')) {
        // Tool calls were made this turn; the execute callback already
        // delivered tool-request events and awaited the browser results.
        messages = [...messages, ...stepMessages];
        continue;
      }
      // No tool calls: final assistant turn.
      pushRunEvent(run, 'text-end', { text });
      pushRunEvent(run, 'finish', { text: await result.text });
      setRunStatus(run, 'completed');
      return;
    }
    pushRunEvent(run, 'text-end', { text });
    pushRunEvent(run, 'finish', { text });
    setRunStatus(run, 'completed');
  } catch (error) {
    if (abort.signal.aborted) {
      setRunStatus(run, 'cancelled');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    run.error = message;
    pushRunEvent(run, 'error', { message });
    setRunStatus(run, 'failed');
  } finally {
    run.abort = undefined;
  }
}
