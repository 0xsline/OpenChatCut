import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { TOOL_SCHEMAS, executeTool } from './tools';
import { SYSTEM_PROMPT } from './systemPrompt';
import { anthropic, MODEL } from './client';

const MAX_TURNS = 8;
const MAX_TOKENS = 1500;

// Anthropic message history is the source of truth we pass back each turn.
export type LLMMessage = Anthropic.MessageParam;

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'error'; message: string };

export function initialMessages(): LLMMessage[] {
  return []; // system prompt is a top-level param in the Messages API, not a message
}

// The agent loop, source-faithful to ChatCut: call Claude's Messages API with
// native tools, run any tool_use blocks against the editor, feed tool_result
// blocks back, repeat until the model stops requesting tools.
export async function runAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (e: AgentEvent) => void,
): Promise<LLMMessage[]> {
  const conv = [...messages];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp: Anthropic.Message;
    try {
      resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: conv,
        tools: TOOL_SCHEMAS,
      });
    } catch (e) {
      const msg = e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : e instanceof Error ? e.message : String(e);
      onEvent({ type: 'error', message: msg.trim() });
      return conv;
    }

    conv.push({ role: 'assistant', content: resp.content });

    // surface any assistant text blocks
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.trim()) onEvent({ type: 'text', content: block.text });
    }

    if (resp.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const args = (block.input ?? {}) as Record<string, unknown>;
        const result = await executeTool(block.name, args, ctx);
        onEvent({ type: 'tool', name: block.name, args, result });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      conv.push({ role: 'user', content: toolResults });
      continue; // let the model observe results and continue
    }

    return conv; // stop_reason end_turn / max_tokens / stop_sequence
  }

  onEvent({ type: 'error', message: `已达最大轮数(${MAX_TURNS})` });
  return conv;
}
