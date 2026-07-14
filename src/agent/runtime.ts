import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { TOOL_SCHEMAS, executeTool } from './tools';
import { SYSTEM_PROMPT, designStylePrompt, creativeModePrompt } from './systemPrompt';
import { findSkill } from './skills-catalog';
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
  opts?: { askOnly?: boolean; signal?: AbortSignal },
): Promise<LLMMessage[]> {
  const conv = [...messages];
  // 问答模式：不给工具 → 模型只答不改时间线（source: Ask vs Agent）
  const tools = opts?.askOnly ? [] : TOOL_SCHEMAS;
  // 系统提示 = 基础 + 设计风格(品牌,source manage_design_style) + 创作模式(source agent_skill)
  const system = SYSTEM_PROMPT
    + designStylePrompt(ctx.getDoc().designStyle)
    + creativeModePrompt(findSkill(ctx.getCreativeMode()));

  for (;;) {
    let resp: Anthropic.Message;
    try {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: conv,
        tools,
      }, { signal: opts?.signal });
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
      // user hit Stop (source onStop): end the turn quietly, no error surfaced
      if (opts?.signal?.aborted || e instanceof Anthropic.APIUserAbortError) return conv;
      const msg = e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e);
      onEvent({ type: 'error', message: msg.trim() });
      return conv;
    }

    conv.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let askedFollowup = false; // ask_followup_questions: render the form + pause for the user's answer
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const args = (block.input ?? {}) as Record<string, unknown>;
        const result = await executeTool(block.name, args, ctx);
        onEvent({ type: 'tool', name: block.name, args, result });
        // ask_followup_questions returns { __followup: <widget text>, note } — render the
        // interactive form to the user (as assistant text → widget-parse → WidgetCard) and
        // STOP the loop; the user's answer arrives as their next message (onWidgetSubmit).
        const followup = (result as { __followup?: string; note?: string } | null)?.__followup;
        if (typeof followup === 'string') {
          onEvent({ type: 'text-start' });
          onEvent({ type: 'text-delta', delta: followup });
          askedFollowup = true;
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: (result as { note?: string }).note ?? 'Follow-up form shown to the user; awaiting their answer.' });
          continue;
        }
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
      if (askedFollowup) return conv; // wait for the user to answer the form before continuing
      continue; // let the model observe results and continue
    }

    return conv; // model stopped on its own (end_turn / max_tokens / stop_sequence)
  }
}
