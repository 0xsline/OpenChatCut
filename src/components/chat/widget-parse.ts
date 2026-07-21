export interface WidgetOption {
  value: string;
  display: string;
}

interface FieldBase {
  id: string;
  label: string;
  description?: string;
  required: boolean;
}

export interface FormSingle extends FieldBase {
  kind: 'single';
  allowOther: boolean;
  otherPlaceholder?: string;
  options: WidgetOption[];
}

export interface FormMulti extends FieldBase {
  kind: 'multi';
  allowOther: boolean;
  otherPlaceholder?: string;
  options: WidgetOption[];
}

export interface FormText extends FieldBase {
  kind: 'text';
  placeholder?: string;
}

export interface RichOption {
  value: string;
  name: string;
  media?: string;
  description?: string;
  aspectRatio?: string;
  submitPrompt?: string;
}

export interface FormRichChoice extends FieldBase {
  kind: 'visual' | 'voice' | 'scenario';
  multiple: boolean;
  options: RichOption[];
}

export type WidgetField = FormSingle | FormMulti | FormText | FormRichChoice;

export interface WidgetSegment {
  type: 'widget';
  fields: WidgetField[];
  title?: string;
  submitLabel?: string;
  messagePrefix?: string;
}

export type MessageSegment = { type: 'text'; text: string } | WidgetSegment;
export type WidgetValues = Record<string, string | string[]>;

const SAFE_WIDGET_DATA_URL = /^data:(?:image\/(?:png|jpe?g|webp|gif)|audio\/(?:mpeg|mp3|wav|ogg|mp4|aac));base64,/i;

/**
 * Widgets are parsed from untrusted model output. Only load media from this app,
 * an already-created blob URL, or a narrowly-scoped inline image/audio payload.
 * This prevents a widget from probing localhost/LAN services or loading trackers.
 */
export function safeWidgetMediaUrl(raw: string | undefined, baseUrl?: string): string | null {
  const value = raw?.trim();
  if (!value || [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) return null;
  if (value.startsWith('blob:')) return value;
  if (SAFE_WIDGET_DATA_URL.test(value)) return value;
  if (value.startsWith('data:')) return null;
  try {
    const base = baseUrl ?? (typeof window !== 'undefined' ? window.location.href : 'http://openchatcut.local/');
    const resolved = new URL(value, base);
    const allowedOrigin = new URL(base).origin;
    if (!['http:', 'https:', 'file:'].includes(resolved.protocol)) return null;
    return resolved.origin === allowedOrigin ? resolved.href : null;
  } catch {
    return null;
  }
}

const WIDGET_RE = /<widget\b([^>]*)>([\s\S]*?)<\/widget>/g;
const FIELD_TAG_RE = /<form-(single|multi|text|visual|voice|scenario)\b([^>]*?)(\/?)>/g;
const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'/g;

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw))) {
    attrs[match[1] ?? match[3]] = decodeEntities(match[2] ?? match[4] ?? '');
  }
  return attrs;
}

function parseOptions(raw: string | undefined): WidgetOption[] {
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('|');
    return separator < 0
      ? { value: entry, display: entry }
      : { value: entry.slice(0, separator).trim(), display: entry.slice(separator + 1).trim() };
  }).filter((option) => option.value && option.display);
}

function parseRichOptions(kind: FormRichChoice['kind'], inner: string): RichOption[] {
  const optionRe = new RegExp(`<${kind}-option\\b([^>]*?)\\/?>`, 'g');
  const options: RichOption[] = [];
  let match: RegExpExecArray | null;
  while ((match = optionRe.exec(inner))) {
    const attrs = parseAttrs(match[1]);
    if (!attrs.value || !attrs.name) continue;
    options.push({
      value: attrs.value,
      name: attrs.name,
      media: attrs.media || undefined,
      description: attrs.description || attrs.summary || undefined,
      aspectRatio: attrs['aspect-ratio'] || undefined,
      submitPrompt: attrs['submit-prompt'] || undefined,
    });
  }
  return options;
}

function fieldBase(attrs: Record<string, string>): FieldBase {
  return {
    id: attrs.id,
    label: attrs.label,
    description: attrs.description || undefined,
    required: attrs.required === 'true',
  };
}

function parseWidgetFields(content: string): WidgetField[] {
  const fields: WidgetField[] = [];
  FIELD_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FIELD_TAG_RE.exec(content))) {
    const kind = match[1] as WidgetField['kind'];
    const attrs = parseAttrs(match[2]);
    const selfClosed = match[3] === '/';
    if (!attrs.id || !attrs.label) continue;

    if (kind === 'text') {
      fields.push({ ...fieldBase(attrs), kind, placeholder: attrs.placeholder || undefined });
      continue;
    }

    if (kind === 'single' || kind === 'multi') {
      const options = parseOptions(attrs.options);
      if (options.length) {
        fields.push({
          ...fieldBase(attrs),
          kind,
          allowOther: attrs.allow_other === 'true',
          otherPlaceholder: attrs.other_placeholder || undefined,
          options,
        });
      }
      continue;
    }

    if (selfClosed) continue;
    const closeTag = `</form-${kind}>`;
    const closeIndex = content.indexOf(closeTag, FIELD_TAG_RE.lastIndex);
    const inner = closeIndex < 0
      ? content.slice(FIELD_TAG_RE.lastIndex)
      : content.slice(FIELD_TAG_RE.lastIndex, closeIndex);
    if (closeIndex >= 0) FIELD_TAG_RE.lastIndex = closeIndex + closeTag.length;
    const options = parseRichOptions(kind, inner);
    if (options.length) {
      fields.push({ ...fieldBase(attrs), kind, multiple: attrs.multiple === 'true', options });
    }
  }
  return fields;
}

/** Parse untrusted model output without injecting HTML or executing code. */
export function parseWidgets(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  WIDGET_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIDGET_RE.exec(text))) {
    const before = text.slice(lastIndex, match.index);
    if (before) segments.push({ type: 'text', text: before });
    let fields: WidgetField[] = [];
    try {
      fields = parseWidgetFields(match[2]);
    } catch {
      fields = [];
    }
    if (fields.length) {
      const attrs = parseAttrs(match[1]);
      segments.push({
        type: 'widget',
        fields,
        title: attrs.title || undefined,
        submitLabel: attrs.submit_label || undefined,
        messagePrefix: attrs.message_prefix || undefined,
      });
    } else {
      segments.push({ type: 'text', text: match[0] });
    }
    lastIndex = WIDGET_RE.lastIndex;
  }
  const rest = text.slice(lastIndex);
  if (rest || segments.length === 0) segments.push({ type: 'text', text: rest });
  return segments;
}

function richDisplay(field: FormRichChoice, value: string): string {
  const option = field.options.find((candidate) => candidate.value === value);
  return option?.submitPrompt || option?.name || value;
}

export function formatWidgetAnswer(fields: WidgetField[], values: WidgetValues, messagePrefix?: string): string {
  const lines: string[] = [];
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;
    if (field.kind === 'multi') {
      const selected = Array.isArray(value) ? value : [value];
      const displays = selected.map((entry) => field.options.find((option) => option.value === entry)?.display ?? entry).filter(Boolean);
      if (displays.length) lines.push(`- ${field.label}：${displays.join('、')}`);
    } else if (field.kind === 'visual' || field.kind === 'voice' || field.kind === 'scenario') {
      const selected = Array.isArray(value) ? value : [value];
      const displays = selected.map((entry) => richDisplay(field, entry)).filter(Boolean);
      if (displays.length) lines.push(`- ${field.label}：${displays.join('、')}`);
    } else if (field.kind === 'text') {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) lines.push(`- ${field.label}：${text}`);
    } else {
      const selected = typeof value === 'string' ? value : '';
      const single = field as FormSingle;
      const display = single.options.find((option) => option.value === selected)?.display ?? selected;
      if (display) lines.push(`- ${field.label}：${display}`);
    }
  }
  return [messagePrefix?.trim(), ...lines].filter(Boolean).join('\n');
}
