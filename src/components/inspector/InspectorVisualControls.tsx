import type { ReactNode } from 'react';
import './InspectorVisualControls.css';
import { theme } from '../../theme';
import type { ClipEffect, ClipEffectValue, ClipFilters, TimelineItem } from '../../editor/types';
import { ALL_FX as FX_EFFECTS, LUT_EFFECTS } from '../../gl/fx/effects';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import { useT } from '../../i18n/locale';
import { ColorParamInput, SliderRow } from './InspectorKeyframeControls';
import type { AutoGradeControlProps } from './InspectorTypes';
import { PreviewFidelityStatus } from './PreviewFidelityStatus';

const FX_IDS = Object.keys(FX_EFFECTS);
const compactNumber = (value: number) => String(Number(value.toFixed(2)));

// small uppercase-ish divider label between control groups.
export function SectionLabel({
  children, onReset, resetDisabled,
}: {
  children: ReactNode;
  onReset?: () => void;
  resetDisabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="cc-insp-section">
      <span>{children}</span>
      {onReset && (
        <button
          className="cc-insp-group-reset"
          disabled={resetDisabled}
          title={t('重置整个分组')}
          type="button"
          onClick={onReset}
        >
          {t('重置')}
        </button>
      )}
    </div>
  );
}

// brightness / contrast / saturation / blur implemented with CSS filters.
export function FilterControl({ item, mixed, onChange, autoGrade }: {
  item: TimelineItem;
  mixed?: Partial<Record<keyof ClipFilters, boolean>>;
  onChange: (p: ClipFilters) => void;
  autoGrade?: AutoGradeControlProps;
}) {
  const t = useT();
  const fl: ClipFilters = { ...item.filters, ...(autoGrade?.selectedPreview?.filters ?? {}) };
  return (
    <div className="cc-insp-stack">
      {autoGrade && (
        <div className={`cc-auto-grade${autoGrade.previewCount ? ' previewing' : ''}`}>
          <div className="cc-auto-grade-head">
            <div>
              <strong>{t('自动校色')}</strong>
              <span>{t('保守型技术修正')}</span>
            </div>
            <button
              type="button"
              className="cc-insp-btn"
              disabled={autoGrade.busy || autoGrade.targetCount === 0}
              onClick={() => void autoGrade.onAnalyze()}
            >
              {autoGrade.busy ? t('分析中…') : t('分析选中片段')}
            </button>
          </div>
          <div className="cc-auto-grade-note">
            {autoGrade.targetCount === 0
              ? t('请选择已导入媒体池的视频、图片或 GIF 片段')
              : t('本机抽样分析，仅做小幅亮度、对比和饱和度修正，不添加创意 LUT。')}
          </div>
          {autoGrade.previewCount > 0 && (
            <div className="cc-auto-grade-result">
              <div>
                <b>{t('预览中 · {n} 个片段', { n: autoGrade.previewCount })}</b>
                {autoGrade.failedCount > 0 && <span>{t(' · {n} 个失败', { n: autoGrade.failedCount })}</span>}
                {autoGrade.selectedPreview && (
                  <span>
                    {` · ${autoGrade.selectedPreview.bitDepth}-bit${autoGrade.selectedPreview.hdr ? ' HDR' : ' SDR'}`}
                    {` · ${Math.round(autoGrade.selectedPreview.filters.brightness * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.contrast * 100)}% / ${Math.round(autoGrade.selectedPreview.filters.saturate * 100)}%`}
                  </span>
                )}
              </div>
              <div className="cc-insp-actions">
                <button type="button" className="cc-insp-btn primary" onClick={autoGrade.onApply}>{t('应用校色')}</button>
                <button type="button" className="cc-insp-btn" onClick={autoGrade.onCancel}>{t('取消预览')}</button>
              </div>
            </div>
          )}
        </div>
      )}
      <SliderRow label={t('亮度')} val={fl.brightness ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.brightness ?? 1) * 100)}%`} inputScale={100} mixed={mixed?.brightness}
        onReset={() => onChange({ brightness: 1 })} resetDisabled={Math.abs((fl.brightness ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ brightness: v })} />
      <SliderRow label={t('对比')} val={fl.contrast ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.contrast ?? 1) * 100)}%`} inputScale={100} mixed={mixed?.contrast}
        onReset={() => onChange({ contrast: 1 })} resetDisabled={Math.abs((fl.contrast ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ contrast: v })} />
      <SliderRow label={t('饱和')} val={fl.saturate ?? 1} min={0} max={2} step={0.05} fmt={`${compactNumber((fl.saturate ?? 1) * 100)}%`} inputScale={100} mixed={mixed?.saturate}
        onReset={() => onChange({ saturate: 1 })} resetDisabled={Math.abs((fl.saturate ?? 1) - 1) < 1e-6} onChange={(v) => onChange({ saturate: v })} />
      <SliderRow label={t('模糊')} val={fl.blur ?? 0} min={0} max={30} step={1} fmt={`${compactNumber(fl.blur ?? 0)}px`} mixed={mixed?.blur}
        onReset={() => onChange({ blur: 0 })} resetDisabled={(fl.blur ?? 0) === 0} onChange={(v) => onChange({ blur: v })} />
    </div>
  );
}

export function BackgroundFillControl({ enabled, mixed = false, onChange }: {
  enabled: boolean;
  mixed?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const t = useT();
  return (
    <label className="cc-insp-toggle-row">
      <span>
        <strong>{t('背景填充')}</strong>
        <small>{t('用模糊的片段副本填满画布')}</small>
      </span>
      <input
        ref={(element) => {
          if (element) element.indeterminate = mixed;
        }}
        type="checkbox"
        checked={enabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={t('背景填充')}
      />
    </label>
  );
}


// Per-clip WebGL effect stack (effects / builtin:fx-*). Order is render
// order: each card consumes the previous card's output.
export function EffectsControl({ item, onChange, previewStatus }: { item: TimelineItem; onChange: (effects: ClipEffect[]) => void; previewStatus?: SelectedPreviewStatus }) {
  const t = useT();
  const effects = item.effects ?? [];
  const active = effects.filter((fx) => fx.assetId in FX_EFFECTS);
  const addEffect = (assetId: string) => {
    if (assetId) onChange([...effects, { id: `fx_${crypto.randomUUID()}`, assetId, overrides: {} }]);
  };
  const updateEffect = (id: string, patch: Partial<ClipEffect>) => onChange(effects.map((fx) => fx.id === id ? { ...fx, ...patch } : fx));
  const setParam = (effect: ClipEffect, key: string, value: ClipEffectValue) => {
    updateEffect(effect.id, { overrides: { ...effect.overrides, [key]: value } });
  };
  const moveEffect = (index: number, delta: number) => {
    const other = active[index + delta];
    if (!other) return;
    const from = effects.findIndex((fx) => fx.id === active[index].id);
    const to = effects.findIndex((fx) => fx.id === other.id);
    const next = [...effects];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  const fmt = (step: number | undefined, v: number) => (step && step < 1 ? v.toFixed(2) : String(Math.round(v)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <select value="" onChange={(e) => addEffect(e.target.value)}
        style={{ width: '100%', background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '5px 7px', fontSize: 12 }}>
        <option value="">{t('＋ 添加特效…')}</option>
        {FX_IDS.map((id) => <option key={id} value={id}>{t(FX_EFFECTS[id].name)}</option>)}
      </select>
      {active.length === 0 && <div style={{ fontSize: 10.5, color: theme.textDim }}>{t('尚未添加特效。')}</div>}
      {active.length > 0 && <PreviewFidelityStatus status={previewStatus} />}
      {active.map((effect, index) => {
        const def = FX_EFFECTS[effect.assetId];
        return (
          <div key={effect.id} style={{ display: 'flex', flexDirection: 'column', gap: 9, border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: theme.text }}>
              <b style={{ flex: 1 }}>{index + 1}. {t(def.name)}
                {effect.assetId in LUT_EFFECTS && <span style={{ fontSize: 9, fontWeight: 700, color: theme.textDim, border: `0.5px solid ${theme.border}`, borderRadius: 3, padding: '0 3px', marginLeft: 5, verticalAlign: 'middle' }}>LUT</span>}
              </b>
              <button title={t('上移')} disabled={index === 0} onClick={() => moveEffect(index, -1)}>↑</button>
              <button title={t('下移')} disabled={index === active.length - 1} onClick={() => moveEffect(index, 1)}>↓</button>
              <button title={t('移除特效')} onClick={() => onChange(effects.filter((fx) => fx.id !== effect.id))}>×</button>
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, opacity: 0.75, lineHeight: 1.4 }}>{t(def.desc)}</div>
            {def.props.map((p) => {
              const raw = effect.overrides?.[p.key] ?? p.default;
              if (p.kind === 'color') {
                const value = Array.isArray(raw) ? raw : p.default;
                return (
                  <label key={p.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: theme.textDim }}>
                    {t(p.label)}
                    <ColorParamInput value={value} onPick={(rgb) => setParam(effect, p.key, rgb)} />
                  </label>
                );
              }
              const value = typeof raw === 'number' ? raw : p.default;
              return (
                <label key={p.key} style={{ display: 'block', fontSize: 11, color: theme.textDim }}>
                  <div style={{ marginBottom: 4 }}>{t(p.label)} <span style={{ opacity: 0.7 }}>{fmt(p.step, value)}</span></div>
                  <input type="range" min={p.min} max={p.max} step={p.step ?? 0.01} value={value} onChange={(e) => setParam(effect, p.key, Number(e.target.value))} style={{ width: '100%' }} />
                </label>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

