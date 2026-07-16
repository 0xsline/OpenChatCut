import Anthropic from '@anthropic-ai/sdk';

// Faithful to the reverse-engineered ChatCut design: the agent talks to
// Anthropic's native Messages API (tool_use / tool_result), NOT a framework.
// See chatcut-reverse/oss_stack.md §5 — "Claude native tool-use, strict tools,
// frameworks add unnecessary abstraction".
//
// Right now the relay (api.aijws.com) has no Claude channel, so we run the
// SAME native protocol against `grok-4.5-latest` through the relay's
// /v1/messages translation layer (verified: tool_use round-trips correctly).
// The day a Claude channel exists, change ONLY this model string to e.g.
// 'claude-sonnet-4-5' — the entire agent is already native Claude tool-use.
export const DEFAULT_LLM_MODEL = 'grok-4.5-latest';

// Runtime-selectable LLM model (settings panel → LLM_MODEL, non-secret). ESM live
// binding: importers (runtime/shader/highlight/tools) always read the current value.
// eslint-disable-next-line prefer-const — mutated by setLlmModel
export let MODEL = DEFAULT_LLM_MODEL;
export function setLlmModel(model: string): void {
  MODEL = model.trim() || DEFAULT_LLM_MODEL;
}

// baseURL → same-origin '/llm' path → Vite dev proxy → relay, with x-api-key
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

// The relay labels non-streaming JSON as text/event-stream, which makes the SDK
// return a stream object. Raw fetch parses the valid JSON body correctly.
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
