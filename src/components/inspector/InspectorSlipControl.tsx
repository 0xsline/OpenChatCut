import { useEffect, useState } from 'react';
import type { SlipPlan, SlipResult } from '../../editor/slip';
import type { TimelineItem } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';

interface InspectorSlipControlProps {
  item: TimelineItem;
  plan: SlipPlan;
  onSlip: (deltaInFrames: number) => SlipResult;
}

export function InspectorSlipControl({ item, plan, onSlip }: InspectorSlipControlProps) {
  const t = useT();
  const [step, setStep] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setStep(1);
    setNotice(null);
  }, [item.id]);

  const run = (direction: -1 | 1) => {
    const result = onSlip(direction * Math.max(1, Math.round(step)));
    if (!result.ok) {
      setNotice(result.error);
      return;
    }
    setNotice(result.clamped
      ? t(result.sourceDomain === 'edited-stream' ? '已到达编辑词流边界' : '已到达源素材边界')
      : null);
  };

  const sourceFrame = (value: number) => value.toFixed(Number.isInteger(value) ? 0 : 2);
  const canEarlier = plan.minDeltaInFrames < -1e-6;
  const canLater = plan.maxDeltaInFrames > 1e-6;
  const sourceStep = plan.sourceDomain === 'edited-stream'
    ? 1
    : Math.max(0.01, item.playbackRate ?? 1);
  const sourceOutFrame = Math.max(plan.sourceWindow.startFrame, plan.sourceWindow.endFrame - sourceStep);
  const displayedRate = plan.sourceDomain === 'edited-stream' ? 1 : (item.playbackRate ?? 1);

  return (
    <div className="cc-insp-stack">
      <div className="cc-insp-row">
        <span className="cc-insp-label">{t(plan.sourceDomain === 'edited-stream' ? '编辑词流区间' : '源区间')}</span>
        <span className="cc-insp-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {sourceFrame(plan.sourceWindow.startFrame)}–{sourceFrame(sourceOutFrame)}f
        </span>
        <span className="cc-insp-val">{displayedRate.toFixed(2)}×</span>
      </div>
      <div className="cc-insp-row">
        <label className="cc-insp-label" htmlFor={`slip-step-${item.id}`}>{t('步长')}</label>
        <input
          id={`slip-step-${item.id}`}
          className="cc-insp-number"
          type="number"
          min={1}
          step={1}
          value={step}
          onChange={(event) => setStep(Math.max(1, Number(event.target.value) || 1))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') run(event.shiftKey ? -1 : 1);
          }}
          aria-describedby={`slip-help-${item.id}`}
        />
        <span className="cc-insp-val">{t('时间线帧')}</span>
      </div>
      <div className="cc-insp-actions">
        <button
          type="button"
          className="cc-insp-btn"
          disabled={!canEarlier}
          onClick={() => run(-1)}
          title={t('将源区间向前滑移，时间线位置和时长不变')}
        >
          <Icon name="prev" size={11} />{t('向前')}
        </button>
        <button
          type="button"
          className="cc-insp-btn"
          disabled={!canLater}
          onClick={() => run(1)}
          title={t('将源区间向后滑移，时间线位置和时长不变')}
        >
          {t('向后')}<Icon name="next" size={11} />
        </button>
      </div>
      <div id={`slip-help-${item.id}`} className="cc-insp-muted" style={{ fontSize: 10 }}>
        {notice ?? t('Enter 向后滑移 · Shift+Enter 向前滑移；仅改变源入点。')}
      </div>
    </div>
  );
}
