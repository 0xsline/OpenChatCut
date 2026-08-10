import { streamText, type LanguageModel } from 'ai';
import { normalizeLlmProvider, type LlmProvider } from '../../shared/llm-providers';
import { pushRunEvent, setRunStatus, type ServerRun } from './store';

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
    const result = streamText({
      model,
      messages: input.messages,
      maxOutputTokens: 4_096,
      maxRetries: 0,
      abortSignal: abort.signal,
    });
    let text = '';
    for await (const delta of result.textStream) {
      text += delta;
      pushRunEvent(run, 'text-delta', { text: delta });
    }
    pushRunEvent(run, 'text-end', { text });
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
