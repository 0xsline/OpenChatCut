import { useState, type CSSProperties } from 'react';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { ScalarControl } from './ScalarControl';
import { useHistoryGesture } from './historyGesture';
import { resolveBackgroundFillToggle } from './backgroundFillControlState';

const STRENGTH_PRESETS = [
  { value: 25, label: '轻度', preview: 'soft' },
  { value: 50, label: '标准', preview: 'medium' },
  { value: 75, label: '强烈', preview: 'strong' },
  { value: 100, label: '极强', preview: 'maximum' },
] as const;

type Translate = (key: string) => string;

interface BackgroundFillControlProps {
  enabled: boolean;
  mixed?: boolean;
  strength: number;
  strengthMixed?: boolean;
  onChange: (enabled: boolean, strength?: number) => void;
  onApplyToAll?: (strength: number) => void;
}

function BackgroundFillStrengthSlider({
  strength, mixed, onChange, translate,
}: {
  strength: number;
  mixed: boolean;
  onChange: (strength: number) => void;
  translate: Translate;
}) {
  const gesture = useHistoryGesture();
  return (
    <div className="cc-insp-row">
      <span className="cc-insp-label">{translate('强度')}</span>
      <input aria-label={translate('背景填充强度')} className="cc-insp-range"
        style={{ '--cc-insp-range-fill': `${strength}%` } as CSSProperties}
        type="range" min={0} max={100} step="any" value={strength} disabled={mixed}
        onChange={(event) => onChange(Math.round(Number(event.target.value)))} {...gesture} />
      <span className="cc-insp-val">
        <ScalarControl ariaLabel={translate('背景填充强度')} formatValue={`${Math.round(strength)}%`}
          mixed={mixed} min={0} max={100} step={1} value={strength}
          onChange={(value) => onChange(Math.round(value))}
          onGestureStart={gesture.onKeyDown} onGestureEnd={gesture.onKeyUp}
          title={translate('背景填充强度')} />
      </span>
    </div>
  );
}

function BackgroundFillStrengthPicker({
  strength, mixed, onChange, translate,
}: {
  strength: number;
  mixed: boolean;
  onChange: (strength: number) => void;
  translate: Translate;
}) {
  return (
    <div className="cc-bg-fill-body">
      <BackgroundFillStrengthSlider
        strength={strength}
        mixed={mixed}
        onChange={onChange}
        translate={translate}
      />
      <div className="cc-bg-fill-presets" role="radiogroup" aria-label={translate('背景填充强度')}>
        {STRENGTH_PRESETS.map(({ value, label, preview }) => (
          <button key={value} type="button" role="radio"
            aria-checked={!mixed && strength === value}
            className={!mixed && strength === value ? 'selected' : ''}
            onClick={() => onChange(value)}>
            <span className={`cc-bg-fill-preview ${preview}`} aria-hidden />
            <small>{translate(label)} {value}%</small>
          </button>
        ))}
      </div>
      {mixed && <div className="cc-insp-muted">{translate('所选片段使用不同的背景强度')}</div>}
    </div>
  );
}

export function BackgroundFillControlView({
  enabled, mixed = false, strength, strengthMixed = false, onChange, onApplyToAll, translate,
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
              const next = resolveBackgroundFillToggle(mixed, event.target.checked, strength, strengthMixed);
              onChange(next.enabled, next.strength);
            }}
            aria-label={translate('背景填充')} />
          <span><strong>{translate('背景填充')}</strong><small>{translate('用片段副本填满画布空白')}</small></span>
        </label>
        <div>
          {onApplyToAll && <button type="button" className="cc-bg-fill-apply"
            disabled={!active || strengthMixed} onClick={() => onApplyToAll(strength)}>{translate('全部应用')}</button>}
          <button type="button" className="cc-bg-fill-disclosure" disabled={!active}
            aria-expanded={active && expanded}
            aria-label={expanded ? translate('收起背景填充效果') : translate('展开背景填充效果')}
            onClick={() => setExpanded((value) => !value)}>
            <span className={expanded ? 'expanded' : ''}><Icon name="chevronDown" size={12} /></span>
          </button>
        </div>
      </div>
      {active && expanded && <BackgroundFillStrengthPicker strength={strength} mixed={strengthMixed}
        translate={translate} onChange={(value) => onChange(true, value)} />}
    </div>
  );
}

export function BackgroundFillControl(props: BackgroundFillControlProps) {
  const translate = useT();
  return <BackgroundFillControlView {...props} translate={translate} />;
}
