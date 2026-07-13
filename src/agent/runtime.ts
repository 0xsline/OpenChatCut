import type { AgentContext } from './context';
import { TOOL_SCHEMAS, executeTool } from './tools';
import { SYSTEM_PROMPT } from './systemPrompt';

const MODEL = 'grok-4.5';
const MAX_TURNS = 8;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type LLMMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'error'; message: string };

export function initialMessages(): LLMMessage[] {
  return [{ role: 'system', content: SYSTEM_PROMPT }];
}

// The agent loop: call the LLM with tools, run any tool calls against the
// editor, feed results back, repeat until the model returns a final answer.
export async function runAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (e: AgentEvent) => void,
): Promise<LLMMessage[]> {
  const conv = [...messages];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let data: {
      choices?: { message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] } }[];
      error?: { message?: string };
    };
    try {
      const resp = await fetch('/llm/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: conv, tools: TOOL_SCHEMAS, tool_choice: 'auto' }),
      });
      if (!resp.ok) {
        onEvent({ type: 'error', message: `LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` });
        return conv;
      }
      data = await resp.json();
    } catch (e) {
      onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      return conv;
    }

    if (data.error) {
      onEvent({ type: 'error', message: data.error.message ?? JSON.stringify(data.error) });
      return conv;
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) {
      onEvent({ type: 'error', message: 'empty LLM response' });
      return conv;
    }
    conv.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* leave empty */
        }
        const result = executeTool(tc.function.name, args, ctx);
        onEvent({ type: 'tool', name: tc.function.name, args, result });
        conv.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue; // let the model observe results and continue
    }

    if (msg.content) onEvent({ type: 'text', content: msg.content });
    return conv;
  }

  onEvent({ type: 'error', message: `已达最大轮数(${MAX_TURNS})` });
  return conv;
}
