import { useState } from 'react';
import type { Proposal } from '../../agent/proposal';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { highCostOps } from '../../agent/skills/skillGuard';

export function ProposalCard({ proposal, onApply, onReject, onPreview, stale, onForceApply, onRePropose }: {
  proposal: Proposal;
  onApply: (selected: Set<number>) => void;
  onReject: () => void;
  onPreview: (on: boolean) => void;
  /** 提案过期(staleness):真时footer换 仍然应用/重新提案/取消 三选 */
  stale?: boolean;
  onForceApply?: (selected: Set<number>) => void;
  onRePropose?: () => void;
}) {
  const t = useT();
  const ops = proposal.options[0].operations;
  const [selected, setSelected] = useState<Set<number>>(() => new Set(ops.map((_, i) => i)));
  const [preview, setPreview] = useState(false);
  const costly = highCostOps(proposal);

  const toggle = (i: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
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
      <header className="cc-proposal-head">
        <div className="cc-proposal-head-left">
          <span className="cc-proposal-icon" aria-hidden>
            <Icon name="sparkles" size={14} />
          </span>
          <div className="cc-proposal-titles">
            <div className="cc-proposal-title-row">
              <h3 className="cc-proposal-title">{proposal.title || t('编辑提案')}</h3>
              <span className="cc-proposal-badge">{t('待确认')}</span>
              {costly.length > 0 && (
                <span className="cc-proposal-badge costly" title={costly.join(', ')}>
                  {t('高成本')}
                </span>
              )}
            </div>
            {costly.length > 0 && (
              <p className="cc-proposal-summary costly">
                {t('Skill guard：包含生成/导出等高成本操作，请确认后再应用。')}
              </p>
            )}
            {proposal.summary ? (
              <p className="cc-proposal-summary">{proposal.summary}</p>
            ) : null}
          </div>
        </div>
        {proposal.totalImpact ? (
          <span className="cc-proposal-impact" title={t('影响范围')}>{proposal.totalImpact}</span>
        ) : null}
      </header>

      <div className="cc-proposal-ops-bar">
        <span className="cc-proposal-ops-label">
          {t('将执行')} <strong>{selected.size}</strong> {t('/ {total} 项', { total: ops.length })}
        </span>
        <div className="cc-proposal-ops-actions">
          <button type="button" className="cc-proposal-link" onClick={selectAll} disabled={allOn}>{t('全选')}</button>
          <button type="button" className="cc-proposal-link" onClick={selectNone} disabled={noneOn}>{t('清空')}</button>
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

      {stale && (
        <div className="cc-proposal-warning" role="alert">
          {t('工程已在提案生成后发生变化：直接应用可能落错位置。')}
        </div>
      )}
      <footer className="cc-proposal-foot">
        <button
          type="button"
          className={`cc-proposal-preview${preview ? ' on' : ''}`}
          onClick={togglePreview}
          title={t('在预览窗查看提案结果（不改正式时间线）')}
        >
          <span className="cc-proposal-preview-dot" />
          {preview ? t('预览中') : t('预览结果')}
        </button>
        <div className="cc-proposal-foot-right">
          <button type="button" className="cc-proposal-reject" onClick={reject}>{stale ? t('取消') : t('拒绝')}</button>
          {stale ? (
            <>
              <button type="button" className="cc-proposal-reject" onClick={() => { onPreview(false); onRePropose?.(); }}>{t('重新提案')}</button>
              <button type="button" className="cc-proposal-apply" disabled={noneOn}
                onClick={() => { onPreview(false); onForceApply?.(selected); }}>
                {t('仍然应用')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="cc-proposal-apply"
              disabled={noneOn}
              onClick={apply}
            >
              {t('应用')}{noneOn ? '' : ` ${selected.size}`}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
