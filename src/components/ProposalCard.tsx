import { useState } from 'react';
import type { Proposal } from '../agent/proposal';
import { Icon } from './icons';

// Edit-proposal review card (source agent-chat proposal). Redesigned as a
// compact dark review panel: header badge + impact, selectable op rows with
// tool chips, then preview / reject / apply actions.

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
  const selectAll = () => setSelected(new Set(ops.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());
  const togglePreview = () => {
    const on = !preview;
    setPreview(on);
    onPreview(on);
  };
  const apply = () => { onPreview(false); onApply(selected); };
  const reject = () => { onPreview(false); onReject(); };

  const allOn = selected.size === ops.length;
  const noneOn = selected.size === 0;

  return (
    <div className="cc-proposal">
      <div className="cc-proposal-glow" aria-hidden />

      <header className="cc-proposal-head">
        <div className="cc-proposal-head-left">
          <span className="cc-proposal-icon" aria-hidden>
            <Icon name="sparkles" size={14} />
          </span>
          <div className="cc-proposal-titles">
            <div className="cc-proposal-title-row">
              <h3 className="cc-proposal-title">{proposal.title || '编辑提案'}</h3>
              <span className="cc-proposal-badge">待确认</span>
            </div>
            {proposal.summary ? (
              <p className="cc-proposal-summary">{proposal.summary}</p>
            ) : null}
          </div>
        </div>
        {proposal.totalImpact ? (
          <span className="cc-proposal-impact" title="影响范围">{proposal.totalImpact}</span>
        ) : null}
      </header>

      <div className="cc-proposal-ops-bar">
        <span className="cc-proposal-ops-label">
          将执行 <strong>{selected.size}</strong> / {ops.length} 项
        </span>
        <div className="cc-proposal-ops-actions">
          <button type="button" className="cc-proposal-link" onClick={selectAll} disabled={allOn}>全选</button>
          <button type="button" className="cc-proposal-link" onClick={selectNone} disabled={noneOn}>清空</button>
        </div>
      </div>

      <ul className="cc-proposal-list">
        {ops.map((op, i) => {
          const on = selected.has(i);
          return (
            <li key={i} className={`cc-proposal-op${on ? '' : ' off'}`}>
              <label className="cc-proposal-op-label">
                <input
                  type="checkbox"
                  className="cc-proposal-check"
                  checked={on}
                  onChange={() => toggle(i)}
                />
                <span className="cc-proposal-check-ui" aria-hidden />
                <span className="cc-proposal-op-body">
                  <span className="cc-proposal-op-main">
                    <span className="cc-proposal-op-action">{op.action}</span>
                    <span className="cc-proposal-op-target" title={op.target}>{op.target}</span>
                  </span>
                  <span className="cc-proposal-op-meta">
                    <span className="cc-proposal-tool">{op.tool}</span>
                    {op.impact ? <span className="cc-proposal-op-impact">{op.impact}</span> : null}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <footer className="cc-proposal-foot">
        <button
          type="button"
          className={`cc-proposal-preview${preview ? ' on' : ''}`}
          onClick={togglePreview}
          title="在预览窗查看提案结果（不改正式时间线）"
        >
          <span className="cc-proposal-preview-dot" />
          {preview ? '预览中' : '预览结果'}
        </button>
        <div className="cc-proposal-foot-right">
          <button type="button" className="cc-proposal-reject" onClick={reject}>拒绝</button>
          <button
            type="button"
            className="cc-proposal-apply"
            disabled={noneOn}
            onClick={apply}
          >
            应用{noneOn ? '' : ` ${selected.size}`}
          </button>
        </div>
      </footer>
    </div>
  );
}
