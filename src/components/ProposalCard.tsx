import { useState } from 'react';
import { theme } from '../theme';
import type { Proposal } from '../agent/proposal';
import { Icon } from './icons';

const ghostBtn: React.CSSProperties = { background: 'none', border: `1px solid ${theme.border}`, borderRadius: 6, color: theme.textDim, cursor: 'pointer', fontSize: 12, padding: '4px 10px' };
const primaryBtn: React.CSSProperties = { background: theme.accent, border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12, padding: '4px 12px', fontWeight: 600 };

// The edit-proposal review card (source: agent-chat proposal). Shows the agent's
// proposed operations; the user can deselect ops, preview the result in the
// player, then apply atomically or reject — the timeline isn't touched until apply.
export function ProposalCard({ proposal, onApply, onReject, onPreview }: {
  proposal: Proposal;
  onApply: (selected: Set<number>) => void;
  onReject: () => void;
  onPreview: (on: boolean) => void;
}) {
  const ops = proposal.options[0].operations;
  const [selected, setSelected] = useState<Set<number>>(() => new Set(ops.map((_, i) => i)));
  const [preview, setPreview] = useState(false);

  const toggle = (i: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  const togglePreview = () => {
    const on = !preview;
    setPreview(on);
    onPreview(on);
  };
  const apply = () => { onPreview(false); onApply(selected); };
  const reject = () => { onPreview(false); onReject(); };

  return (
    <div style={{ border: `1px solid ${theme.accent}`, borderRadius: 10, background: theme.panelAlt, padding: 12, margin: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: theme.text, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="sparkles" size={12} />{proposal.title}</span>
        <span style={{ fontSize: 10, color: theme.accent, border: `1px solid ${theme.accent}`, borderRadius: 4, padding: '0 5px' }}>待确认</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: theme.textDim }}>{proposal.totalImpact}</span>
      </div>
      {proposal.summary && <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 8, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{proposal.summary}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {ops.map((op, i) => {
          const on = selected.has(i);
          return (
            <label key={i} title={op.rationale ?? op.tool} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, cursor: 'pointer', opacity: on ? 1 : 0.5, textDecoration: on ? 'none' : 'line-through' }}>
              <input type="checkbox" checked={on} onChange={() => toggle(i)} />
              <span style={{ color: theme.text }}>{op.action}</span>
              <span style={{ color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{op.target}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>{op.impact}</span>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={togglePreview} style={{ ...ghostBtn, color: preview ? theme.accent : theme.textDim, borderColor: preview ? theme.accent : theme.border }}>
          {preview ? '● 预览中' : '预览'}
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={reject} style={ghostBtn}>拒绝</button>
        <button onClick={apply} disabled={selected.size === 0} style={{ ...primaryBtn, opacity: selected.size ? 1 : 0.5, cursor: selected.size ? 'pointer' : 'default' }}>应用 {selected.size}/{ops.length}</button>
      </div>
    </div>
  );
}
