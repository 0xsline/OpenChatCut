import Anthropic from '@anthropic-ai/sdk';

// The agent talks to
// Anthropic's native Messages API (tool_use / tool_result), NOT a framework.
//
// The default endpoint is Anthropic's official API. Compatible relays remain
// supported by setting LLM_BASE_URL because they expose the same /v1/messages
// tool-use protocol.
export const DEFAULT_LLM_MODEL = 'claude-fable-5';

// Runtime-selectable LLM model (settings panel → LLM_MODEL, non-secret). ESM live
// binding: importers (runtime/shader/highlight/tools) always read the current value.
// eslint-disable-next-line prefer-const — mutated by setLlmModel
export let MODEL = DEFAULT_LLM_MODEL;
export function setLlmModel(model: string): void {
  MODEL = model.trim() || DEFAULT_LLM_MODEL;
}

// baseURL → same-origin '/llm' path → server proxy → provider, with x-api-key
// injected server-side so the key never reaches the browser. The Anthropic SDK
// requires an ABSOLUTE baseURL (unlike raw fetch), hence location.origin.
// apiKey here is a placeholder the proxy overwrites; dangerouslyAllowBrowser is
// safe because the real key is not present in the browser.
// `window` is absent under node/tsx (the .check.ts runnable checks import tool
// modules that transitively load this file); fall back to a placeholder origin
// so importing never throws — the client is only actually CALLED in the browser.
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
export const anthropic = new Anthropic({
  baseURL: `${ORIGIN}/llm`,
  apiKey: 'proxy-injects-the-real-key',
  dangerouslyAllowBrowser: true,
});

// Some compatible relays label non-streaming JSON as text/event-stream, which
// makes the SDK return a stream object. Raw fetch parses the JSON body reliably.
export async function createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  const response = await fetch('/llm/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'proxy-injects-the-real-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...params, stream: false }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `LLM request failed (${response.status})`);
  return body as Anthropic.Message;
}
