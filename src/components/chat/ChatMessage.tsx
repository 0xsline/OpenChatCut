import { useState } from 'react';
import { theme } from '../../theme';
import type { DisplayMessage } from '../../agent/useAgent';
import { Icon, type IconName } from '../icons';

const GREEN = '#3fae6a';

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
}

export function ChatMessage({ msg, streaming, feedback, onFeedback }: ChatMessageProps) {
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
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '9px 0', color: theme.textDim, fontSize: 12.5 }}
        title={typeof t.args === 'object' ? JSON.stringify(t.args) : String(t.args)}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? GREEN : theme.accent, flexShrink: 0 }} />
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{t.name}</span>
        {!ok && <span style={{ color: theme.accent }}>— {String(r!.error)}</span>}
      </div>
    );
  }

  if (msg.role === 'error') {
    return <div style={{ color: theme.accent, fontSize: 12.5, margin: '8px 0' }}>⚠ {msg.text}</div>;
  }

  // assistant
  return (
    <div style={{ margin: '16px 0' }}>
      <div style={{ color: theme.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>{msg.text}</div>
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
