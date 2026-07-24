import { useState } from 'react';
import { theme } from '../../theme';
import { Icon } from '../icons';
import { useT } from '../../i18n/locale';
import type { DisplayMessage } from '../../agent/useAgent';
import { parseWidgets } from './widget-parse';
import { WidgetCard } from './WidgetCard';
import { Markdown } from './Markdown';

const GREEN = theme.success;

// Take the "most distinguishing" one from the tool parameters and make an in-line summary - sort by identification: identify it specifically first
// (query/itemId/name…), and then generalize (action/target…). Make multiple calls with the same name identifiable at a glance and no longer look like repetitions.
const SUMMARY_KEYS = ['query', 'itemId', 'templateName', 'audioName', 'name', 'from', 'to', 'templateId', 'category', 'ratio', 'action', 'format', 'target', 'track', 'renderId'];
function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  for (const k of SUMMARY_KEYS) {
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (k === 'itemId' || k === 'templateId' || k === 'renderId') s = s.slice(0, 8); // uuid only takes the first 8
    if (s.length > 26) s = s.slice(0, 24) + '…';
    return s;
  }
  return '';
}

// Collapsed "Thinking Process" block — native thinking flow and inline <thinking> extractions go here
// (Both are folded into thinking blocks and folded by default).
function ThinkingBlock({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 6 }}>
      <button onClick={() => setOpen((v) => !v)} title={open ? t('Stop thinking process') : t('Develop thought process')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, fontSize: 11.5, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        {t('thought process')}
      </button>
      {open && (
        <Markdown text={text} style={{ marginTop: 4, maxHeight: 180, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontStyle: 'italic', fontSize: 11.5, lineHeight: 1.55, color: theme.textDim, whiteSpace: 'pre-wrap', borderLeft: `2px solid ${theme.borderLight}`, paddingLeft: 8 }} />
      )}
    </div>
  );
}

interface ChatMessageProps {
  msg: DisplayMessage;
  /** the actively-streaming assistant turn hides the copy button until done */
  streaming?: boolean;
  /** User completes <widget> After the form is uploaded and submitted, the assembled answer text will be returned. */
  onWidgetSubmit?: (answer: string) => void;
  /** maxTurns Pause card "Continue";Only the last one continue Koke points(Old card read only) */
  onContinue?: (() => void) | null;
}

export function ChatMessage({ msg, streaming, onWidgetSubmit, onContinue }: ChatMessageProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(msg.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };

  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0' }}>
      <div style={{ maxWidth: '86%', background: theme.hover, color: theme.text, borderRadius: 6, padding: '9px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'tool') {
    const tool = msg.tool!;
    const r = tool.result as Record<string, unknown> | undefined;
    const ok = !r || !('error' in r);
    // Summary of key parameters: multiple calls of the tool with the same name (search_templates×7, normalize_loudness×8…)
    // Previously, only the tool name was printed, which looked like repetition; add the distinguishing parameters (query/itemId/category...) for easy identification at a glance.
    const summary = toolArgSummary(tool.args);
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '9px 0', color: theme.textDim, fontSize: 12.5 }}
        title={typeof tool.args === 'object' ? JSON.stringify(tool.args) : String(tool.args)}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? GREEN : theme.accent, flexShrink: 0, marginTop: 5 }} />
        {/* Tool name + Summary + Error in same wrappable block:minWidth:0 so that it can be in flex contraction within the father,
            overflowWrap:anywhere broken length token —— Long error/summary within panel wrap, no longer will a single line be cut when it overflows. */}
        <span style={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.45 }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{tool.name}</span>
          {summary && <span style={{ opacity: 0.8 }}> · {summary}</span>}
          {!ok && <span style={{ color: theme.accent }}> — {String(r!.error)}</span>}
        </span>
      </div>
    );
  }

  if (msg.role === 'error') {
    return <div style={{ color: theme.accent, fontSize: 12.5, margin: '8px 0' }}>⚠ {msg.text}</div>;
  }

  // maxTurns pause card ("continue?"): text = number of rounds executed
  if (msg.role === 'continue') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', padding: '9px 12px',
        border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panelAlt, fontSize: 12.5, color: theme.textDim,
      }}>
        <span style={{ flex: 1 }}>{t('executed continuously {n} wheel tool, stop for a moment to confirm the direction.', { n: msg.text })}</span>
        {onContinue && (
          <button type="button" onClick={onContinue}
            style={{ border: `0.5px solid ${theme.accent}`, background: 'transparent', color: theme.accent, borderRadius: 6, padding: '4px 14px', fontSize: 12.5, cursor: 'pointer', flexShrink: 0 }}>
            {t('continue')}
          </button>
        )}
      </div>
    );
  }

  // The <widget> form block may be embedded in the assistant text and needs to be separated into paragraphs to render separately.
  // The plain text segment uses lightweight Markdown (**bold** / `code` / list / code block), and no longer spits out ** to the user as it is
  const segments = parseWidgets(msg.text);
  return (
    <div style={{ margin: '16px 0' }}>
      {!!msg.thinking?.trim() && <ThinkingBlock text={msg.thinking} />}
      {segments.map((seg, i) =>
        seg.type === 'widget' ? (
          <WidgetCard
            key={i}
            fields={seg.fields}
            title={seg.title}
            submitLabel={seg.submitLabel}
            messagePrefix={seg.messagePrefix}
            onSubmit={(answer) => onWidgetSubmit?.(answer)}
          />
        ) : (
          seg.text ? <Markdown key={i} text={seg.text} /> : null
        ),
      )}
      {!streaming && msg.text.trim() && (
        <div style={{ marginTop: 6, marginLeft: -5 }}>
          <button title={copied ? t('Copied') : t('copy text')} onClick={copy}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 5, borderRadius: 6, lineHeight: 0, color: copied ? theme.text : theme.textDim, display: 'grid', placeItems: 'center' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.panelAlt; e.currentTarget.style.color = theme.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = copied ? theme.text : theme.textDim; }}>
            <Icon name="copy" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
