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
export const MODEL = 'grok-4.5-latest';

// baseURL → same-origin '/llm' path → Vite dev proxy → relay, with x-api-key
// injected server-side so the key never reaches the browser. The Anthropic SDK
// requires an ABSOLUTE baseURL (unlike raw fetch), hence location.origin.
// apiKey here is a placeholder the proxy overwrites; dangerouslyAllowBrowser is
// safe because the real key is not present in the browser.
export const anthropic = new Anthropic({
  baseURL: `${window.location.origin}/llm`,
  apiKey: 'proxy-injects-the-real-key',
  dangerouslyAllowBrowser: true,
});
