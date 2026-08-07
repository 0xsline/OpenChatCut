import type { CaptionMotionPreset } from './types';
import { CAPTION_MOTION_OPTIONS } from './captionMotion';
import { useT } from '../i18n/locale';

interface CaptionMotionControlsProps {
  value: CaptionMotionPreset | undefined;
  onChange: (value: CaptionMotionPreset) => void;
}

export function CaptionMotionControls({ value, onChange }: CaptionMotionControlsProps) {
  const t = useT();
  const selected = value ?? 'none';
  return (
    <div className="cc-cap-field">
      <div className="cc-cap-label">{t('字幕动效')}</div>
      <div className="cc-cap-pills" role="listbox" aria-label={t('字幕动效')}>
        {CAPTION_MOTION_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={selected === option.id}
            className={`cc-cap-pill${selected === option.id ? ' selected' : ''}`}
            onClick={() => onChange(option.id)}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
      <p className="cc-cap-hint">{t('动效按时间线帧计算，预览与导出保持一致。')}</p>
    </div>
  );
}
