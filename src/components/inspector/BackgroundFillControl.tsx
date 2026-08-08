import { useState } from 'react';
import type { BackgroundFillPreset } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { resolveBackgroundFillToggle } from './backgroundFillControlState';

const PRESET_LABELS: Record<BackgroundFillPreset, string> = {
  soft: '轻度',
  medium: '标准',
  strong: '强烈',
  maximum: '极强',
};

type Translate = (key: string) => string;

interface BackgroundFillControlProps {
  enabled: boolean;
  mixed?: boolean;
  preset: BackgroundFillPreset;
  presetMixed?: boolean;
  onChange: (enabled: boolean, preset?: BackgroundFillPreset) => void;
  onApplyToAll?: (preset: BackgroundFillPreset) => void;
}

function BackgroundFillEffectPicker({
  preset, mixed, onChange, translate,
}: {
  preset: BackgroundFillPreset;
  mixed: boolean;
  onChange: (preset: BackgroundFillPreset) => void;
  translate: Translate;
}) {
  return (
    <div className="cc-bg-fill-body">
      <div className="cc-bg-fill-mode">
        <strong>{translate('模糊')}</strong>
        <span>{translate('选择背景模糊强度')}</span>
      </div>
      <div className="cc-bg-fill-presets" role="radiogroup" aria-label={translate('背景填充效果')}>
        {(Object.keys(PRESET_LABELS) as BackgroundFillPreset[]).map((value) => (
          <button key={value} type="button" role="radio"
            aria-checked={!mixed && preset === value}
            className={!mixed && preset === value ? 'selected' : ''}
            onClick={() => onChange(value)}>
            <span className={`cc-bg-fill-preview ${value}`} aria-hidden />
            <small>{translate(PRESET_LABELS[value])}</small>
          </button>
        ))}
      </div>
      {mixed && <div className="cc-insp-muted">{translate('所选片段使用不同的背景效果')}</div>}
    </div>
  );
}

export function BackgroundFillControlView({
  enabled, mixed = false, preset, presetMixed = false, onChange, onApplyToAll, translate,
}: BackgroundFillControlProps & { translate: Translate }) {
  const [expanded, setExpanded] = useState(true);
  const active = enabled || mixed;
  return (
    <div className="cc-bg-fill-control">
      <div className="cc-bg-fill-head">
        <label>
          <input ref={(element) => { if (element) element.indeterminate = mixed; }}
            type="checkbox" checked={enabled}
            onChange={(event) => {
              const next = resolveBackgroundFillToggle(mixed, event.target.checked, preset, presetMixed);
              onChange(next.enabled, next.preset);
            }}
            aria-label={translate('背景填充')} />
          <span><strong>{translate('背景填充')}</strong><small>{translate('用片段副本填满画布空白')}</small></span>
        </label>
        <div>
          {onApplyToAll && <button type="button" className="cc-bg-fill-apply"
            disabled={!active || presetMixed} onClick={() => onApplyToAll(preset)}>{translate('全部应用')}</button>}
          <button type="button" className="cc-bg-fill-disclosure" disabled={!active}
            aria-expanded={active && expanded}
            aria-label={expanded ? translate('收起背景填充效果') : translate('展开背景填充效果')}
            onClick={() => setExpanded((value) => !value)}>
            <span className={expanded ? 'expanded' : ''}><Icon name="chevronDown" size={12} /></span>
          </button>
        </div>
      </div>
      {active && expanded && <BackgroundFillEffectPicker preset={preset} mixed={presetMixed}
        translate={translate} onChange={(value) => onChange(true, value)} />}
    </div>
  );
}

export function BackgroundFillControl(props: BackgroundFillControlProps) {
  const translate = useT();
  return <BackgroundFillControlView {...props} translate={translate} />;
}
