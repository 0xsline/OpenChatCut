import { useState } from 'react';
import { theme } from '../../theme';
import type { DisplayMessage } from '../../agent/useAgent';
import { Icon, type IconName } from '../icons';
import { parseWidgets } from './widget-parse';
import { WidgetCard } from './WidgetCard';
import { Markdown } from './Markdown';

const GREEN = '#3fae6a';

// 从工具参数里取「最有区分度」的那一个做行内摘要——按识别性排序:先具体标识
// (query/itemId/名字…)，再泛化(action/target…)。让同名多次调用一眼可辨，不再像重复。
const SUMMARY_KEYS = ['query', 'itemId', 'templateName', 'audioName', 'name', 'from', 'to', 'templateId', 'category', 'ratio', 'action', 'format', 'target', 'track', 'renderId'];
function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  for (const k of SUMMARY_KEYS) {
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (k === 'itemId' || k === 'templateId' || k === 'renderId') s = s.slice(0, 8); // uuid 只取前 8
    if (s.length > 26) s = s.slice(0, 24) + '…';
    return s;
  }
  return '';
}

// 折叠的「思考过程」块 — 原生 thinking 流与内联 <thinking> 抽取都归到这里
// (source 20100-20150:两者统一折成 thinking 块,默认折叠)。
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 6 }}>
      <button onClick={() => setOpen((v) => !v)} title={open ? '收起思考过程' : '展开思考过程'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, fontSize: 11.5, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        思考过程
      </button>
      {open && (
        <div style={{ marginTop: 4, maxHeight: 180, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontStyle: 'italic', fontSize: 11.5, lineHeight: 1.55, color: theme.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderLeft: `2px solid ${theme.borderLight}`, paddingLeft: 8 }}>
          {text}
        </div>
      )}
    </div>
  );
}

// one AI-message action button (copy / 👍 / 👎) — muted line icon, source style
function ActBtn({ icon, title, active, onClick }: { icon: IconName; title: string; active?: boolean; onClick: () => void }) {
  return (
    <button title={title} onClick={onClick}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 5, borderRadius: 6, lineHeight: 0, color: active ? theme.text : theme.textDim, display: 'grid', placeItems: 'center' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.panelAlt; e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = active ? theme.text : theme.textDim; }}>
      <Icon name={icon} size={15} />
    </button>
  );
}

interface ChatMessageProps {
  msg: DisplayMessage;
  /** the actively-streaming assistant turn hides its action row until done */
  streaming?: boolean;
  feedback?: 'up' | 'down' | null;
  onFeedback?: (v: 'up' | 'down') => void;
  /** 用户填完 <widget> 表单卡并提交后，回传拼好的答案文本（source ask_followup_questions） */
  onWidgetSubmit?: (answer: string) => void;
}

export function ChatMessage({ msg, streaming, feedback, onFeedback, onWidgetSubmit }: ChatMessageProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(msg.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };

  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0' }}>
        <div style={{ maxWidth: '86%', background: '#3a3a3a', color: '#fff', borderRadius: 16, padding: '9px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'tool') {
    const t = msg.tool!;
    const r = t.result as Record<string, unknown> | undefined;
    const ok = !r || !('error' in r);
    // 关键参数摘要:同名工具的多次调用(search_templates×7、normalize_loudness×8…)
    // 之前只印工具名，看着像重复；补上区分性参数(query/itemId/category…)一眼可辨。
    const summary = toolArgSummary(t.args);
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '9px 0', color: theme.textDim, fontSize: 12.5 }}
        title={typeof t.args === 'object' ? JSON.stringify(t.args) : String(t.args)}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? GREEN : theme.accent, flexShrink: 0, marginTop: 5 }} />
        {/* 工具名 + 摘要 + 错误同处一个可换行块:minWidth:0 让它能在 flex 父内收缩，
            overflowWrap:anywhere 断长 token —— 长错误/摘要在面板内 wrap，不再单行溢出被裁。 */}
        <span style={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.45 }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{t.name}</span>
          {summary && <span style={{ opacity: 0.8 }}> · {summary}</span>}
          {!ok && <span style={{ color: theme.accent }}> — {String(r!.error)}</span>}
        </span>
      </div>
    );
  }

  if (msg.role === 'error') {
    return <div style={{ color: theme.accent, fontSize: 12.5, margin: '8px 0' }}>⚠ {msg.text}</div>;
  }

  // assistant — 文本里可能嵌了 <widget> 表单块（source ask_followup_questions），拆段落分别渲染
  // 纯文本段走轻量 Markdown（**粗体** / `code` / 列表 / 代码块），不再把 ** 原样吐给用户
  const segments = parseWidgets(msg.text);
  return (
    <div style={{ margin: '16px 0' }}>
      {!!msg.thinking?.trim() && <ThinkingBlock text={msg.thinking} />}
      {segments.map((seg, i) =>
        seg.type === 'widget' ? (
          <WidgetCard key={i} fields={seg.fields} onSubmit={(answer) => onWidgetSubmit?.(answer)} />
        ) : (
          seg.text ? <Markdown key={i} text={seg.text} /> : null
        ),
      )}
      {!streaming && msg.text.trim() && (
        <div style={{ display: 'flex', gap: 1, marginTop: 6, marginLeft: -5 }}>
          <ActBtn icon="copy" title={copied ? '已复制' : '复制'} active={copied} onClick={copy} />
          <ActBtn icon="thumbUp" title="有帮助" active={feedback === 'up'} onClick={() => onFeedback?.('up')} />
          <ActBtn icon="thumbDown" title="没帮助" active={feedback === 'down'} onClick={() => onFeedback?.('down')} />
        </div>
      )}
    </div>
  );
}
