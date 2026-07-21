import { type FocusEvent, useState } from 'react';
import type { TimelineItem } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4] as const;

function SpeedMenu({ rate, onChange }: { rate: number; onChange: (rate: number) => void }) {
  const t = useT();
  return (
    <div data-testid="timeline-speed-menu" style={{
      position: 'absolute', top: 30, left: 0, zIndex: 30, width: 224,
      padding: 10, background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
      borderRadius: 6, boxShadow: `0 10px 28px ${themeAlpha.shadow(0.32)}`,
    }}>
      <div style={{ color: theme.text, fontSize: 12, fontWeight: 650, marginBottom: 8 }}>{t('变速')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
        {SPEED_PRESETS.map((preset) => {
          const active = Math.abs(rate - preset) < 0.01;
          return (
            <button key={preset} type="button" onClick={() => onChange(preset)}
              style={{
                height: 28, border: `0.5px solid ${active ? theme.accent : theme.border}`,
                borderRadius: 4, background: active ? theme.hover : theme.panel,
                color: active ? theme.textStrong : theme.textMuted,
                cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 500,
              }}>
              {preset}×
            </button>
          );
        })}
      </div>
      <div style={{ color: theme.textDim, fontSize: 10, lineHeight: 1.45, marginTop: 8 }}>
        {t('保调变速（预览/导出）· 时长随速率伸缩并波纹合缝')}
      </div>
    </div>
  );
}

export function TimelineSpeedControl({
  item,
  onChange,
}: {
  item: TimelineItem | null;
  onChange: (rate: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rate = item?.playbackRate ?? 1;
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  const applyRate = (nextRate: number) => {
    onChange(nextRate);
    setOpen(false);
  };

  return (
    <div data-testid="timeline-speed-control" onBlur={handleBlur} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" disabled={!item} aria-expanded={open} aria-label={t('变速')}
        className="cc-tip" data-tip={t('变速')} onClick={() => setOpen((value) => !value)}
        style={{
          height: 24, minWidth: 45, padding: '0 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          border: `0.5px solid ${open ? theme.accent : theme.border}`, borderRadius: 4,
          color: item ? theme.textMuted : theme.textDim, background: open ? theme.hover : 'transparent',
          cursor: item ? 'pointer' : 'default', opacity: item ? 1 : 0.4,
          fontSize: 11, fontVariantNumeric: 'tabular-nums',
        }}>
        <Icon name="clock" size={14} />
        <span>{rate}×</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {open && item && <SpeedMenu rate={rate} onChange={applyRate} />}
    </div>
  );
}
