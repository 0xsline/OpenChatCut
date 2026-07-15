import { useState } from 'react';
import { theme } from '../../theme';
import { ChatMessage } from './ChatMessage';
import type { DisplayMessage } from '../../agent/useAgent';

const GREEN = '#3fae6a';

// Collapsed row for a run of same-name tool calls: "● edit_gap · 20 次 ▸".
// Click to expand the individual rows (each keeps its own arg summary). Mirrors
// the single tool-row look in ChatMessage so the collapsed/expanded states match.
export function ToolGroupRow({ name, items }: { name: string; items: { msg: DisplayMessage; index: number }[] }) {
  const [open, setOpen] = useState(false);
  const anyError = items.some(({ msg }) => {
    const r = msg.tool?.result as Record<string, unknown> | undefined;
    return !!r && 'error' in r;
  });
  return (
    <div style={{ margin: '9px 0' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? '收起' : '展开全部'}
        style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, fontSize: 12.5, padding: 0, textAlign: 'left' }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: anyError ? theme.accent : GREEN, flexShrink: 0 }} />
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{name}</span>
        <span style={{ opacity: 0.8 }}>· {items.length} 次</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ marginLeft: 3, paddingLeft: 9, borderLeft: `1px solid ${theme.border}` }}>
          {items.map(({ msg, index }) => (
            <ChatMessage key={index} msg={msg} />
          ))}
        </div>
      )}
    </div>
  );
}
