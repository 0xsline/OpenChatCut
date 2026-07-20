// 纯解析器（无 React/DOM 依赖）：把助手消息文本中的 <widget> 表单块解析成结构化数据。
// widget XML 是不可信的 LLM 输出——全程用正则/字符串处理，不用 innerHTML、不用 eval，
// 解析失败一律退化为纯文本，绝不抛错（见 parseWidgets 尾部注释）。

export interface WidgetOption {
  value: string;
  display: string;
}

export interface FormSingle {
  kind: 'single';
  id: string;
  label: string;
  required: boolean;
  allowOther: boolean;
  options: WidgetOption[];
}

export interface FormMulti {
  kind: 'multi';
  id: string;
  label: string;
  required: boolean;
  allowOther: boolean;
  options: WidgetOption[];
}

export interface VisualOption {
  value: string;
  name: string;
  media?: string;
  summary?: string;
  aspectRatio?: string;
}

export interface FormVisual {
  kind: 'visual';
  id: string;
  label: string;
  required: boolean;
  options: VisualOption[];
}

export type WidgetField = FormSingle | FormMulti | FormVisual;

export type MessageSegment = { type: 'text'; text: string } | { type: 'widget'; fields: WidgetField[] };

/** 提交时的选中值：single/visual 是选中项的 value（或 allow_other 时用户输入的自由文本），multi 是 value 数组 */
export type WidgetValues = Record<string, string | string[]>;

const WIDGET_RE = /<widget>([\s\S]*?)<\/widget>/g;
const FIELD_TAG_RE = /<form-(single|multi|visual)\b([^>]*?)(\/)?>/g;
const VISUAL_OPTION_RE = /<visual-option\b([^>]*?)\/?>/g;
const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'/g;

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    const key = m[1] ?? m[3];
    const val = decodeEntities(m[2] ?? m[4] ?? '');
    attrs[key] = val;
  }
  return attrs;
}

// options="60s|约1分钟,180s|约3分钟" → [{value:'60s',display:'约1分钟'}, ...]；没有 "|" 时 value=display
function parseOptions(raw: string | undefined): WidgetOption[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const i = item.indexOf('|');
      return i === -1 ? { value: item, display: item } : { value: item.slice(0, i).trim(), display: item.slice(i + 1).trim() };
    });
}

function parseVisualOptions(inner: string): VisualOption[] {
  const options: VisualOption[] = [];
  VISUAL_OPTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VISUAL_OPTION_RE.exec(inner))) {
    const a = parseAttrs(m[1]);
    if (!a.value || !a.name) continue; // 缺关键字段的选项丢弃
    options.push({ value: a.value, name: a.name, media: a.media || undefined, summary: a.summary || undefined, aspectRatio: a['aspect-ratio'] || undefined });
  }
  return options;
}

function parseWidgetFields(content: string): WidgetField[] {
  const fields: WidgetField[] = [];
  FIELD_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_TAG_RE.exec(content))) {
    const kind = m[1] as 'single' | 'multi' | 'visual';
    const attrs = parseAttrs(m[2]);
    const selfClosed = !!m[3];

    if (kind === 'visual') {
      if (selfClosed) continue; // 没有 visual-option 子元素的字段没有意义，丢弃
      const closeTag = '</form-visual>';
      const closeIdx = content.indexOf(closeTag, FIELD_TAG_RE.lastIndex);
      const inner = closeIdx === -1 ? content.slice(FIELD_TAG_RE.lastIndex) : content.slice(FIELD_TAG_RE.lastIndex, closeIdx);
      if (closeIdx !== -1) FIELD_TAG_RE.lastIndex = closeIdx + closeTag.length;
      const options = parseVisualOptions(inner);
      if (attrs.id && attrs.label && options.length) {
        fields.push({ kind: 'visual', id: attrs.id, label: attrs.label, required: attrs.required === 'true', options });
      }
      continue;
    }

    if (!selfClosed) {
      // single/multi 按规范是自闭合标签；容错跳过误写的闭合标签，避免吞掉后续字段
      const closeTag = `</form-${kind}>`;
      const closeIdx = content.indexOf(closeTag, FIELD_TAG_RE.lastIndex);
      if (closeIdx !== -1) FIELD_TAG_RE.lastIndex = closeIdx + closeTag.length;
    }
    const options = parseOptions(attrs.options);
    if (attrs.id && attrs.label && options.length) {
      fields.push({ kind, id: attrs.id, label: attrs.label, required: attrs.required === 'true', allowOther: attrs.allow_other === 'true', options });
    }
  }
  return fields;
}

/**
 * 把消息文本按 <widget> 块拆成有序的 {text} / {widget} 段落。
 * 容错策略：单个 widget 解析异常或解出 0 个字段时，把该块原样当纯文本输出；整个函数永不抛错。
 */
export function parseWidgets(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  WIDGET_RE.lastIndex = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIDGET_RE.exec(text))) {
    const before = text.slice(lastIndex, m.index);
    if (before) segments.push({ type: 'text', text: before });
    let fields: WidgetField[] = [];
    try {
      fields = parseWidgetFields(m[1]);
    } catch {
      fields = [];
    }
    segments.push(fields.length ? { type: 'widget', fields } : { type: 'text', text: m[0] });
    lastIndex = WIDGET_RE.lastIndex;
  }
  const rest = text.slice(lastIndex);
  if (rest || segments.length === 0) segments.push({ type: 'text', text: rest });
  return segments;
}

// 拼答案格式：一行一个字段 `- {label}：{已选展示文本}`，multi 用「、」拼接，未作答的字段跳过。
export function formatWidgetAnswer(fields: WidgetField[], values: WidgetValues): string {
  const lines: string[] = [];
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined) continue;
    if (f.kind === 'multi') {
      const arr = Array.isArray(v) ? v : [v];
      const displays = arr.map((val) => f.options.find((o) => o.value === val)?.display ?? val).filter(Boolean);
      if (displays.length) lines.push(`- ${f.label}：${displays.join('、')}`);
    } else if (f.kind === 'visual') {
      const name = f.options.find((o) => o.value === v)?.name;
      if (name) lines.push(`- ${f.label}：${name}`);
    } else {
      const value = typeof v === 'string' ? v : '';
      // 匹配不到固定选项时说明是 allow_other 的自由文本，直接用输入值本身作展示
      const display = f.options.find((o) => o.value === value)?.display ?? value;
      if (display) lines.push(`- ${f.label}：${display}`);
    }
  }
  return lines.join('\n');
}
