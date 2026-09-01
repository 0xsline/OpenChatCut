import type { TextStreamPart, ToolSet } from 'ai';
import { createInlineThinkingExtractor } from '../../src/agent/settings/agentSettings';
import { effectiveOutputTokenBudget } from '../../src/agent/context-compaction';
import { pushRunEvent, type ServerRun } from './store';

const TEXT_EVENT_CHARS = 8_192;

export function resolveServerRunMaxOutputTokens(
  requested: number,
  capabilityLimit: number,
  contextWindow: number,
): number {
  return Math.min(requested, effectiveOutputTokenBudget(capabilityLimit, contextWindow));
}

function flushRunEvents(
  run: ServerRun,
  event: 'text-delta' | 'thinking-delta',
  pending: string,
  force: boolean,
): string {
  let remainder = pending;
  while (remainder.length >= TEXT_EVENT_CHARS) {
    pushRunEvent(run, event, { text: remainder.slice(0, TEXT_EVENT_CHARS) });
    remainder = remainder.slice(TEXT_EVENT_CHARS);
  }
  if (force && remainder) {
    pushRunEvent(run, event, { text: remainder });
    return '';
  }
  return remainder;
}

export const flushTextEvents = (run: ServerRun, pending: string, force: boolean): string =>
  flushRunEvents(run, 'text-delta', pending, force);

export const flushThinkingEvents = (run: ServerRun, pending: string, force: boolean): string =>
  flushRunEvents(run, 'thinking-delta', pending, force);

export function serverRunTextMetadata(text: string): { characterCount: number; utf8Bytes: number } {
  return { characterCount: text.length, utf8Bytes: Buffer.byteLength(text) };
}

export async function collectServerText<TOOLS extends ToolSet>(
  run: ServerRun,
  stream: AsyncIterable<TextStreamPart<TOOLS>>,
): Promise<string> {
  const extractor = createInlineThinkingExtractor();
  let text = '';
  let pending = '';
  let pendingThinking = '';
  const appendVisible = (visible: string): void => {
    if (!visible) return;
    text += visible;
    pending = flushTextEvents(run, pending + visible, false);
  };
  const appendThinking = (thinking: string): void => {
    if (!thinking) return;
    pendingThinking = flushThinkingEvents(run, pendingThinking + thinking, false);
  };
  // Force-flush the pending tail on a short timer: without it, a reply shorter
  // than TEXT_EVENT_CHARS stays entirely in server memory until the turn ends,
  // and a browser reload mid-run loses the whole in-flight text.
  const flushTimer = setInterval(() => {
    if (pending) pending = flushTextEvents(run, pending, true);
    if (pendingThinking) pendingThinking = flushThinkingEvents(run, pendingThinking, true);
  }, 2_000);
  // Emit the trailing text and the closing event exactly once, on the success
  // path and on the failing one alike: a provider error must not cost the user
  // the text that already streamed.
  const finish = (): string => {
    const tail = extractor.flush();
    appendVisible(tail.text);
    appendThinking(tail.thinking);
    flushTextEvents(run, pending, true);
    flushThinkingEvents(run, pendingThinking, true);
    pushRunEvent(run, 'text-end', serverRunTextMetadata(text));
    return text;
  };
  try {
    for await (const part of stream) {
      // `fullStream` reports provider failures as `error` parts instead of
      // throwing. Swallowing them discards the real APICallError — its status
      // code and response body, which carry the proxy's actionable message —
      // and lets the turn fail later on the AI SDK's generic
      // NoOutputGeneratedError, which classifyLlmFailure cannot route to AUTH,
      // RATE_LIMIT or QUOTA. Rethrow so the real cause reaches the user.
      if (part.type === 'error') {
        finish();
        throw part.error;
      }
      if (part.type === 'reasoning-delta' && part.text) {
        // Native reasoning streams (DeepSeek/OpenAI/… reasoning_content) never
        // appear in the visible text stream; forward them as thinking events.
        appendThinking(part.text);
        continue;
      }
      if (part.type !== 'text-delta' || !part.text) continue;
      const split = extractor.push(part.text);
      appendVisible(split.text);
      appendThinking(split.thinking);
    }
  } finally {
    clearInterval(flushTimer);
  }
  return finish();
}
