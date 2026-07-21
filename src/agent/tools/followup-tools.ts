import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';

type Args = Record<string, unknown>;

export const FOLLOWUP_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'ask_followup_questions',
  description:
    'Ask the user up to 12 follow-up questions in an interactive card, then WAIT for the next user message. Each field accepts type "single", "multi", or "text" and variant "default", "visual", "voice", or "scenario". Options accept id/label (or value/display), description, preview/media, audioUrl, aspectRatio, and submitPrompt. Use text fields for free-form answers, visual for image choices, voice for playable voice choices, and scenario for workflow choices.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'Fields: { id, label, type, variant?, description?, placeholder?, otherPlaceholder?, options?, required?, allowOther? }.',
        items: { type: 'object' },
      },
      prompt: { type: 'string', description: 'Optional text shown above the card.' },
      title: { type: 'string', description: 'Optional card title.' },
      submitLabel: { type: 'string', description: 'Optional submit button label.' },
      messagePrefix: { type: 'string', description: 'Optional prefix prepended to the submitted answer.' },
    },
    required: ['fields'],
  },
}];

export const FOLLOWUP_TOOL_NAMES = new Set(FOLLOWUP_TOOL_SCHEMAS.map((t) => t.name));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface RawField {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  variant?: unknown;
  description?: unknown;
  placeholder?: unknown;
  otherPlaceholder?: unknown;
  options?: unknown;
  required?: unknown;
  allowOther?: unknown;
}

interface NormalizedOption {
  value: string;
  display: string;
  description?: string;
  media?: string;
  audioUrl?: string;
  aspectRatio?: string;
  submitPrompt?: string;
}

function stringValue(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function previewUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return stringValue(value);
  if (!value || typeof value !== 'object') return undefined;
  const preview = value as Record<string, unknown>;
  return stringValue(preview.url ?? preview.media ?? preview.src);
}

function normalizeOptions(options: unknown): NormalizedOption[] {
  if (typeof options === 'string') {
    return options.split(',').map((entry) => {
      const [value, display] = entry.split('|', 2).map((part) => part.trim());
      return { value, display: display || value };
    }).filter((option) => option.value);
  }
  if (!Array.isArray(options)) return [];
  return options.map((option): NormalizedOption | null => {
    if (option && typeof option === 'object') {
      const raw = option as Record<string, unknown>;
      const value = stringValue(raw.value ?? raw.id);
      if (!value) return null;
      return {
        value,
        display: stringValue(raw.display ?? raw.label ?? raw.name) ?? value,
        description: stringValue(raw.description ?? raw.summary),
        media: stringValue(raw.media) ?? previewUrl(raw.preview),
        audioUrl: stringValue(raw.audioUrl),
        aspectRatio: stringValue(raw.aspectRatio),
        submitPrompt: stringValue(raw.submitPrompt),
      };
    }
    const value = stringValue(option);
    return value ? { value, display: value } : null;
  }).filter((option): option is NormalizedOption => option !== null);
}

function attrs(values: Record<string, string | boolean | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false && value !== '')
    .map(([key, value]) => ` ${key}="${esc(String(value))}"`)
    .join('');
}

function serializeChoiceOptions(kind: 'visual' | 'voice' | 'scenario', options: NormalizedOption[]): string {
  return options.map((option) => {
    const media = kind === 'voice' ? option.audioUrl ?? option.media : option.media;
    return `<${kind}-option${attrs({
      value: option.value,
      name: option.display,
      description: option.description,
      media,
      'aspect-ratio': option.aspectRatio,
      'submit-prompt': option.submitPrompt,
    })}/>`;
  }).join('\n');
}

/** Serialize follow-up fields into the editor's safe, declarative widget format. */
export function buildFollowupWidget(fields: RawField[], prompt: string, options: {
  title?: string;
  submitLabel?: string;
  messagePrefix?: string;
} = {}): string {
  const tags: string[] = [];
  let auto = 0;
  for (const field of fields) {
    const label = stringValue(field?.label);
    if (!label) continue;
    const id = stringValue(field.id) ?? `q${++auto}`;
    const type = field.type === 'multi' || field.type === 'text' ? field.type : 'single';
    const variant = field.variant === 'visual' || field.variant === 'voice' || field.variant === 'scenario'
      ? field.variant
      : 'default';
    const common = attrs({
      id,
      label,
      description: stringValue(field.description),
      placeholder: stringValue(field.placeholder),
      other_placeholder: stringValue(field.otherPlaceholder),
      required: field.required === true ? 'true' : undefined,
      allow_other: field.allowOther === true ? 'true' : undefined,
    });
    if (type === 'text') {
      tags.push(`<form-text${common}/>`);
      continue;
    }
    const normalized = normalizeOptions(field.options);
    if (!normalized.length) continue;
    if (variant === 'default') {
      const encoded = normalized.map((option) => option.display !== option.value
        ? `${option.value}|${option.display}`
        : option.value).join(',');
      tags.push(`<form-${type}${common} options="${esc(encoded)}"/>`);
      continue;
    }
    const inner = serializeChoiceOptions(variant, normalized);
    tags.push(`<form-${variant}${common}${type === 'multi' ? ' multiple="true"' : ''}>\n${inner}\n</form-${variant}>`);
  }
  if (!tags.length) return prompt.trim();
  const widgetAttrs = attrs({
    title: stringValue(options.title),
    submit_label: stringValue(options.submitLabel),
    message_prefix: stringValue(options.messagePrefix),
  });
  const lead = prompt.trim() ? `${prompt.trim()}\n\n` : '';
  return `${lead}<widget${widgetAttrs}>\n${tags.join('\n')}\n</widget>`;
}

export function execFollowupTool(name: string, args: Args, _ctx: AgentContext): unknown {
  if (name !== 'ask_followup_questions') return { error: `unknown tool ${name}` };
  const fields = Array.isArray(args.fields) ? (args.fields as RawField[]) : [];
  if (!fields.length) return { error: 'ask_followup_questions requires a non-empty fields array' };
  const text = buildFollowupWidget(fields.slice(0, 12), String(args.prompt ?? '').trim(), {
    title: stringValue(args.title),
    submitLabel: stringValue(args.submitLabel),
    messagePrefix: stringValue(args.messagePrefix),
  });
  if (!text.includes('<widget')) return { error: 'no renderable fields (each needs a label; choice fields also need options)' };
  return { __followup: text, note: 'Follow-up form shown to the user. Wait for their reply — it will arrive as their next message.' };
}
