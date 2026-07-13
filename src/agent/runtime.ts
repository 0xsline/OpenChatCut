import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { TOOL_SCHEMAS, executeTool } from './tools';
import { SYSTEM_PROMPT } from './systemPrompt';
import { anthropic, MODEL } from './client';

// No artificial limits — the loop runs until the model itself stops requesting
// tools (stop_reason !== 'tool_use'). max_tokens is a required per-request
// ceiling (can't be infinite); set to the highest the relay accepts — the model
// stops on its own well before it.
const MAX_TOKENS = 64000;

// Anthropic message history is the source of truth we pass back each turn.
export type LLMMessage = Anthropic.MessageParam;

export type AgentEvent =
  | { type: 'text-start' } // a new assistant text block begins
  | { type: 'text-delta'; delta: string } // streamed token(s) to append
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'error'; message: string };

export function initialMessages(): LLMMessage[] {
  return []; // system prompt is a top-level param in the Messages API, not a message
}

// The agent loop, source-faithful to ChatCut: STREAM Claude's Messages API with
// native tools, surfacing assistant text token-by-token; when a turn requests
// tools, run them against the editor, feed tool_result blocks back, repeat.
export async function runAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (e: AgentEvent) => void,
): Promise<LLMMessage[]> {
  const conv = [...messages];

  for (;;) {
    let resp: Anthropic.Message;
    try {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: conv,
        tools: TOOL_SCHEMAS,
      });
      let textStarted = false;
      stream.on('text', (delta) => {
        if (!delta) return;
        if (!textStarted) {
          onEvent({ type: 'text-start' });
          textStarted = true;
        }
        onEvent({ type: 'text-delta', delta });
      });
      resp = await stream.finalMessage();
    } catch (e) {
      const msg = e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e);
      onEvent({ type: 'error', message: msg.trim() });
      return conv;
    }

    conv.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const args = (block.input ?? {}) as Record<string, unknown>;
        const result = await executeTool(block.name, args, ctx);
        onEvent({ type: 'tool', name: block.name, args, result });
        // tools may return image blocks (view_timeline_frames: the model SEES
        // rendered frames) via { __images: [{frame, base64}], note } — build a
        // multimodal tool_result; everything else stays JSON text.
        const imgs = (result as { __images?: { frame: number; base64: string }[]; note?: string } | null)?.__images;
        const content: Anthropic.ToolResultBlockParam['content'] = Array.isArray(imgs)
          ? [
              ...imgs.map((im) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: im.base64 },
              })),
              { type: 'text' as const, text: (result as { note?: string }).note ?? `${imgs.length} frames rendered` },
            ]
          : JSON.stringify(result);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
      }
      conv.push({ role: 'user', content: toolResults });
      continue; // let the model observe results and continue
    }

    return conv; // model stopped on its own (end_turn / max_tokens / stop_sequence)
  }
}
