import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';

// ask_followup_questions (MCP tool, required: ['fields']): agent 主动向用户发一张
// 交互表单卡问关键信息。本仓 UI 早有 <widget> 解析(widget-parse.ts + WidgetCard),这里
// 补成正式 TOOL——之前只靠 systemPrompt 教模型吐 <widget> 文本、agent 无法"调用"它
// (旧 TODO 误记为 ✅)。这里补工具:exec 把 fields 序列化成 <widget> 文本,经 runtime 的
// __followup 特判渲染成卡片并暂停 loop 等用户作答(答案由现成 onWidgetSubmit 回填为下条用户
// 消息)。本仓 widget 支持 single/multi;text 自由输入暂无自由框→降级为 prompt
// 里的一行提问。title/submitLabel 本仓 WidgetCard 不渲染,接收但忽略。

type Args = Record<string, unknown>;

export const FOLLOWUP_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'ask_followup_questions',
  description:
    'Ask the user follow-up questions as an interactive form card in chat, then WAIT for their answer (it arrives as their next message). Use when key info is missing before you can act. fields: array (≤12) of { id, label, type:"single"|"multi", options:[{value,display}], required?, allowOther? }. single = pick one, multi = pick several, allowOther lets them type a custom value. Free-text-only questions render as a prompt line (this editor has no free-text field). Do NOT keep acting until the user answers.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'Form fields; each { id, label, type:"single"|"multi", options:[{value,display}], required?, allowOther? }.',
        items: { type: 'object' },
      },
      prompt: { type: 'string', description: 'Optional text shown above the form.' },
      title: { type: 'string', description: 'Optional form title.' },
      submitLabel: { type: 'string', description: 'Optional submit button label.' },
    },
    required: ['fields'],
  },
}];

export const FOLLOWUP_TOOL_NAMES = new Set(FOLLOWUP_TOOL_SCHEMAS.map((t) => t.name));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface RawField { id?: unknown; label?: unknown; type?: unknown; options?: unknown; required?: unknown; allowOther?: unknown; }

/** options → "value|display,value|display"; accepts [{value,display}] | string[] | "a,b|c". */
function optionsToStr(options: unknown): string {
  if (typeof options === 'string') return options.trim();
  if (!Array.isArray(options)) return '';
  return options.map((o) => {
    if (o && typeof o === 'object') {
      const v = String((o as { value?: unknown }).value ?? '').trim();
      const d = String((o as { display?: unknown }).display ?? v).trim();
      return v ? (d && d !== v ? `${v}|${d}` : v) : '';
    }
    return String(o ?? '').trim();
  }).filter(Boolean).join(',');
}

/** serialize fields → a <widget> block; option-less (free-text) fields fall back to prompt lines. */
export function buildFollowupWidget(fields: RawField[], prompt: string): string {
  const lines: string[] = [];
  if (prompt) lines.push(prompt);
  const tags: string[] = [];
  let auto = 0;
  for (const f of fields) {
    const label = String(f?.label ?? '').trim();
    if (!label) continue;
    const id = String(f.id ?? '').trim() || `q${++auto}`;
    const kind = f.type === 'multi' ? 'multi' : 'single';
    const opts = optionsToStr(f.options);
    if (!opts) { lines.push(`- ${label}`); continue; } // 无选项(自由输入)→提问行
    const required = f.required === true ? ' required="true"' : '';
    const allowOther = f.allowOther === true ? ' allow_other="true"' : '';
    tags.push(`<form-${kind} id="${esc(id)}" label="${esc(label)}" options="${esc(opts)}"${required}${allowOther}/>`);
  }
  const lead = lines.length ? `${lines.join('\n')}\n\n` : '';
  return tags.length ? `${lead}<widget>\n${tags.join('\n')}\n</widget>` : lead.trim();
}

export function execFollowupTool(name: string, args: Args, _ctx: AgentContext): unknown {
  if (name !== 'ask_followup_questions') return { error: `unknown tool ${name}` };
  const fields = Array.isArray(args.fields) ? (args.fields as RawField[]) : [];
  if (!fields.length) return { error: 'ask_followup_questions requires a non-empty fields array' };
  const text = buildFollowupWidget(fields.slice(0, 12), String(args.prompt ?? '').trim());
  if (!text) return { error: 'no renderable fields (each needs a label; single/multi need options)' };
  // __followup → runtime renders the card as assistant text + stops the loop to wait for the answer.
  return { __followup: text, note: 'Follow-up form shown to the user. Wait for their reply — it will arrive as their next message.' };
}
