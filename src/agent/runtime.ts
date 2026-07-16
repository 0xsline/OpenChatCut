import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { TOOL_SCHEMAS, executeTool } from './tools';
import { SYSTEM_PROMPT, designStylePrompt, creativeModePrompt } from './systemPrompt';
import { capabilitiesPrompt } from './capabilities';
import { findSkill } from './skills-catalog';
import { PLUGIN_SKILLS_INDEX } from './plugin-skills';
import { anthropic, MODEL } from './client';
import { agentSettingsPrompt, createInlineThinkingExtractor, loadAgentSettings } from './agentSettings';

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
  | { type: 'thinking-delta'; delta: string } // 推理流(原生 thinking_delta 或内联 <thinking> 抽取)
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
  const settings = loadAgentSettings();
  // 系统提示 = 基础 + 可用能力清单(按 key 配置) + 设计风格(品牌) + 创作模式(agent_skill)
  // + <agent_settings>(MG 质量档/planMode;源站 Hy@24231 注入每条消息,本仓等价拼进 system)
  const system = SYSTEM_PROMPT
    + capabilitiesPrompt()
    + designStylePrompt(ctx.getDoc().designStyle)
    + creativeModePrompt(findSkill(ctx.getCreativeMode()))
    + PLUGIN_SKILLS_INDEX
    + agentSettingsPrompt(settings);

  // 思考模式 (source: `chatcut-thinking-enabled-v3` 开 → thinking:'adaptive' + effort:'medium')。
  // 容错红线:中转(grok /v1/messages 翻译层)可能拒该参数 —— 首个流事件前报错且
  // message 像参数错时,去参重试一次;thinkingFellBack 保证整次 runAgent 只触发一次。
  let thinkingFellBack = false;

  for (;;) {
    let resp: Anthropic.Message;
    const withThinking = settings.thinkingEnabled && !thinkingFellBack;
    // 内联 <thinking>…</thinking> 抽取:标签内的文本走 thinking 通道不进正文(source 20100-20150)
    const extract = createInlineThinkingExtractor();
    let sawStreamEvent = false;
    let textStarted = false;
    const emitText = (delta: string) => {
      if (!textStarted) {
        onEvent({ type: 'text-start' });
        textStarted = true;
      }
      onEvent({ type: 'text-delta', delta });
    };
    try {
      const stream = anthropic.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: conv,
        tools,
        ...(withThinking ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'medium' as const } } : {}),
      }, { signal: opts?.signal });
      stream.on('streamEvent', () => { sawStreamEvent = true; });
      stream.on('text', (delta) => {
        if (!delta) return;
        const part = extract.push(delta);
        if (part.thinking) onEvent({ type: 'thinking-delta', delta: part.thinking });
        if (part.text) emitText(part.text);
      });
      // 原生推理流(relay 若透传 thinking_delta,SDK 聚合为该事件)
      stream.on('thinking', (delta) => {
        if (delta) onEvent({ type: 'thinking-delta', delta });
      });
      resp = await stream.finalMessage();
      // 流结束:结算内联抽取状态机(未闭合 → 余量全归 thinking;半截开标签只是正文)
      const tail = extract.flush();
      if (tail.thinking) onEvent({ type: 'thinking-delta', delta: tail.thinking });
      if (tail.text) emitText(tail.text);
    } catch (e) {
      // user hit Stop (source onStop): end the turn quietly, no error surfaced
      if (opts?.signal?.aborted || e instanceof Anthropic.APIUserAbortError) return conv;
      const msg = e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e);
      // 中转拒 thinking 参数(首个流事件前 + param 类字样)→ 去参重试一次,并插系统提示
      if (withThinking && !sawStreamEvent && /thinking|param|invalid|unsupported|不支持/i.test(msg)) {
        thinkingFellBack = true;
        onEvent({ type: 'error', message: '当前中转不支持思考模式，已自动关闭本轮' });
        continue;
      }
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
