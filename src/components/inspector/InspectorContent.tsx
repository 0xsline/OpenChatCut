import { useEffect, useId, type KeyboardEvent } from 'react';
import type { PropSpec } from '../../types';
import type { TimelineItem } from '../../editor/types';
import { KEYFRAME_PROPS, getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { inspectorMixedValue } from '../../editor/inspectorBatch';
import { useT } from '../../i18n/locale';
import { PropSchemaField } from './PropSchemaField';
import { TransformControl, VolumeControl } from './InspectorKeyframeControls';
import { FadeControl, IsolateVoiceControl, SpeedControl, TextControl, TransitionControl, ZoomControl } from './InspectorMediaControls';
import { EffectsControl, FilterControl, SectionLabel } from './InspectorVisualControls';
import type { InspectorPanelProps } from './InspectorTypes';
import { InspectorSlipControl } from './InspectorSlipControl';
import { groupInspectorPropSchema } from './inspectorPropSchemaLayout';

export type InspectorTab = 'basic' | 'video' | 'audio' | 'animation';

interface InspectorContentProps {
  panel: InspectorPanelProps;
  item: TimelineItem;
  schema: PropSpec[];
  playheadLocal: { localFrame: number; inRange: boolean };
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
}

const TAB_DEFS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'basic', label: '基础' },
  { id: 'video', label: '视频' },
  { id: 'audio', label: '音频' },
  { id: 'animation', label: '动画' },
];
function nextInspectorTab(
  current: InspectorTab,
  key: string,
  available: Record<InspectorTab, boolean>,
): InspectorTab | null {
  const tabs = TAB_DEFS.filter((tab) => available[tab.id]).map((tab) => tab.id);
  const index = tabs.indexOf(current);
  if (key === 'Home') return tabs[0] ?? null;
  if (key === 'End') return tabs.at(-1) ?? null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return tabs[(index + 1) % tabs.length] ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return tabs[(index - 1 + tabs.length) % tabs.length] ?? null;
  return null;
}
const isMixed = <T,>(panel: InspectorPanelProps, read: (item: TimelineItem) => T): boolean =>
  inspectorMixedValue(panel.selectedItems, read).mixed;


export function InspectorContent(props: InspectorContentProps) {
  const { item, panel, activeTab, onTabChange } = props;
  const tabGroupId = useId();
  const selection = panel.selectedItems.length ? panel.selectedItems : [item];
  const available: Record<InspectorTab, boolean> = {
    basic: true,
    video: selection.every((entry) => entry.kind !== 'audio'),
    audio: selection.every((entry) => entry.kind === 'audio' || entry.kind === 'video'),
    animation: true,
  };
  const activeAvailable =
    activeTab === 'basic' ? available.basic
    : activeTab === 'video' ? available.video
    : activeTab === 'audio' ? available.audio
    : available.animation;
  useEffect(() => {
    if (!activeAvailable) onTabChange('basic');
  }, [activeAvailable, onTabChange]);
  const visibleTab = available[activeTab] ? activeTab : 'basic';
  return (
    <>
      <InspectorTabBar id={tabGroupId} activeTab={visibleTab} available={available} onChange={onTabChange} />
      <div
        id={`${tabGroupId}-panel`}
        className="cc-insp-body"
        role="tabpanel"
        aria-labelledby={`${tabGroupId}-${visibleTab}-tab`}
      >
        <div className="cc-insp-groups">
          <InspectorHint item={item} count={panel.selectedItems.length} />
          <InspectorTabContent {...props} activeTab={visibleTab} />
        </div>
      </div>
    </>
  );
}

function InspectorTabBar({ id, activeTab, available, onChange }: {
  id: string;
  activeTab: InspectorTab;
  available: Record<InspectorTab, boolean>;
  onChange: (tab: InspectorTab) => void;
}) {
  const t = useT();
  const selectFromKey = (event: KeyboardEvent, current: InspectorTab) => {
    const next = nextInspectorTab(current, event.key, available);
    if (!next) return;
    event.preventDefault();
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`${id}-${next}-tab`)?.focus());
  };
  return (
    <div className="cc-insp-tabs" role="tablist" aria-label={t('属性分类')}>
      {TAB_DEFS.map((tab) => <button
        id={`${id}-${tab.id}-tab`}
        key={tab.id}
        type="button"
        role="tab"
        aria-controls={`${id}-panel`}
        aria-selected={activeTab === tab.id}
        tabIndex={activeTab === tab.id ? 0 : -1}
        disabled={!available[tab.id]}
        className={activeTab === tab.id ? 'active' : ''}
        onClick={() => onChange(tab.id)}
        onKeyDown={(event) => selectFromKey(event, tab.id)}
      >{t(tab.label)}</button>)}
    </div>
  );
}

function InspectorTabContent(props: InspectorContentProps) {
  if (props.activeTab === 'video') return <VideoTab {...props} />;
  if (props.activeTab === 'audio') return <AudioTab {...props} />;
  if (props.activeTab === 'animation') return <AnimationTab {...props} />;
  return <BasicTab {...props} />;
}

function BasicTab({ panel, item, schema, playheadLocal }: InspectorContentProps) {
  const t = useT();
  const transformProps = KEYFRAME_PROPS.filter((prop) => prop !== 'volume' && getKeyframePropertyDefinition(prop).supports(item));
  const resetDisabled = !transformProps.some((prop) => {
    const definition = getKeyframePropertyDefinition(prop);
    return !!item.keyframes?.[prop]?.length || Math.abs(definition.getBaseValue(item) - definition.defaultValue) >= 1e-6;
  });
  return (
    <>
      {panel.selectedItems.length === 1 && panel.slipPlan && panel.onItemSlip && (
        <>
          <SectionLabel>{t('滑移')}</SectionLabel>
          <InspectorSlipControl
            item={item}
            plan={panel.slipPlan}
            onSlip={panel.onItemSlip}
          />
        </>
      )}
      {item.kind === 'text' && panel.selectedItems.every((entry) => entry.kind === 'text') && <><SectionLabel>{t('文字')}</SectionLabel><TextControl item={item} mixed={(key) => isMixed(panel, (entry) => entry.props?.[key])} onPropChange={panel.onItemPropChange} /></>}
      {panel.selectedItems.every((entry) => entry.kind !== 'audio') && <><SectionLabel onReset={() => panel.onResetItemKeyframes(transformProps)} resetDisabled={resetDisabled && !transformProps.some((prop) => isMixed(panel, (entry) => getKeyframePropertyDefinition(prop).getBaseValue(entry)))}>{t('变换')}</SectionLabel><TransformControl item={item} mixed={(prop) => {
        const definition = getKeyframePropertyDefinition(prop);
        return isMixed(panel, (entry) => entry.keyframes?.[prop] ?? definition.getBaseValue(entry));
      }} onChange={panel.onItemTransformChange} onReset={panel.onResetItemKeyframes} kf={{
        ...playheadLocal,
        set: panel.onSetItemKeyframe,
        remove: panel.onRemoveItemKeyframe,
        seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
      }} /></>}
      {item.kind === 'solid' && panel.selectedItems.every((entry) => entry.kind === 'solid') && <SolidColorField item={item} mixed={isMixed(panel, (entry) => entry.props?.color ?? '#1a1a1a')} onChange={panel.onItemPropChange} />}
      {item.kind === 'motion-graphic' && panel.selectedItems.every((entry) => entry.kind === 'motion-graphic' && entry.templateId === item.templateId) && <MotionGraphicFields item={item} schema={schema} mixed={(key) => isMixed(panel, (entry) => entry.props?.[key])} onChange={panel.onItemPropChange} />}
    </>
  );
}

function VideoTab({ panel, item }: InspectorContentProps) {
  const t = useT();
  const filters = item.filters;
  const resetDisabled = Math.abs((filters?.brightness ?? 1) - 1) < 1e-6
    && Math.abs((filters?.contrast ?? 1) - 1) < 1e-6
    && Math.abs((filters?.saturate ?? 1) - 1) < 1e-6
    && (filters?.blur ?? 0) === 0;
  const effectsMixed = isMixed(panel, (entry) => entry.effects ?? []);
  return (
    <>
      <SectionLabel onReset={() => panel.onItemFiltersChange({ brightness: 1, contrast: 1, saturate: 1, blur: 0 })} resetDisabled={resetDisabled && !isMixed(panel, (entry) => entry.filters)}>{t('滤镜')}</SectionLabel>
      <FilterControl item={item} mixed={{
        brightness: isMixed(panel, (entry) => entry.filters?.brightness ?? 1),
        contrast: isMixed(panel, (entry) => entry.filters?.contrast ?? 1),
        saturate: isMixed(panel, (entry) => entry.filters?.saturate ?? 1),
        blur: isMixed(panel, (entry) => entry.filters?.blur ?? 0),
      }} onChange={panel.onItemFiltersChange} autoGrade={panel.autoGrade} />
      {(item.kind === 'video' || item.kind === 'image') && panel.selectedItems.every((entry) => entry.kind === 'video' || entry.kind === 'image') && <><SectionLabel>{t('特效')}</SectionLabel>{effectsMixed ? <div className="cc-insp-muted">{t('所选片段的特效堆栈不同；请先统一堆栈后再批量编辑。')}</div> : <EffectsControl item={item} onChange={panel.onItemEffectsChange} previewStatus={panel.selectedPreviewStatuses?.find((status) => status.kind === 'effect' && status.targetId === item.id)} />}</>}
    </>
  );
}

function AudioTab({ panel, item, playheadLocal }: InspectorContentProps) {
  const t = useT();
  return (
    <>
      <SectionLabel>{t('音量')}</SectionLabel>
      <VolumeControl item={item} mixed={isMixed(panel, (entry) => entry.volume ?? 1)} onChange={panel.onItemVolumeChange} onNormalize={panel.selectedItems.every((entry) => entry.kind === 'audio') ? panel.onNormalizeLoudness : undefined} onReset={panel.onResetItemKeyframes} kf={{
        ...playheadLocal,
        set: panel.onSetItemKeyframe,
        remove: panel.onRemoveItemKeyframe,
        seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
      }} />
      {panel.onIsolateVoice && panel.selectedItems.length === 1 && <><SectionLabel>{t('人声隔离')}</SectionLabel><IsolateVoiceControl item={item} onIsolate={panel.onIsolateVoice} /></>}
    </>
  );
}

function AnimationTab({ panel, item }: InspectorContentProps) {
  const t = useT();
  const visual = panel.selectedItems.every((entry) => entry.kind !== 'audio');
  return (
    <>
      {(item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence') && panel.onItemSpeedChange && <><SectionLabel>{t('变速')}</SectionLabel><SpeedControl item={item} mixed={isMixed(panel, (entry) => entry.playbackRate ?? 1)} onChange={panel.onItemSpeedChange} /></>}
      {visual && <><SectionLabel onReset={() => panel.onItemZoomChange(null)} resetDisabled={!item.zoom && !isMixed(panel, (entry) => entry.zoom)}>{t('缩放')}</SectionLabel><ZoomControl zoom={item.zoom} mixed={{
        shape: isMixed(panel, (entry) => entry.zoom?.shape),
        magnification: isMixed(panel, (entry) => entry.zoom?.magnification ?? 1.5),
        focalPointX: isMixed(panel, (entry) => entry.zoom?.focalPointX ?? 0.5),
        focalPointY: isMixed(panel, (entry) => entry.zoom?.focalPointY ?? 0.5),
      }} onChange={panel.onItemZoomChange} getLocalFrame={() => Math.max(0, Math.min(item.durationInFrames - 1, panel.getPlayhead() - item.startFrame))} fps={panel.fps} onSetKeyframe={panel.onSetReframeKeyframe} onRemoveKeyframe={panel.onRemoveReframeKeyframe} /></>}
      {visual && panel.selectedItems.length === 1 && <><SectionLabel>{t('转场')}</SectionLabel><TransitionControl transition={panel.transition} fps={panel.fps} onAdd={panel.onAddTransition} onSet={panel.onSetTransition} onRemove={panel.onRemoveTransition} audioMode={false} previewStatus={panel.selectedPreviewStatuses?.find((status) => status.kind === 'transition' && status.targetId === panel.transition?.id)} /></>}
      {item.kind === 'audio' && panel.selectedItems.length === 1 && <><SectionLabel>{t('音频转场')}</SectionLabel><TransitionControl transition={panel.transition} fps={panel.fps} onAdd={panel.onAddTransition} onSet={panel.onSetTransition} onRemove={panel.onRemoveTransition} audioMode /></>}
      <SectionLabel onReset={() => panel.onItemFadeChange({ fadeInFrames: 0, fadeOutFrames: 0 })} resetDisabled={(item.fadeInFrames ?? 0) === 0 && (item.fadeOutFrames ?? 0) === 0 && !isMixed(panel, (entry) => [entry.fadeInFrames ?? 0, entry.fadeOutFrames ?? 0])}>{t('淡入淡出')}</SectionLabel>
      <FadeControl item={item} mixed={{ fadeInFrames: isMixed(panel, (entry) => entry.fadeInFrames ?? 0), fadeOutFrames: isMixed(panel, (entry) => entry.fadeOutFrames ?? 0) }} fps={panel.fps} onChange={panel.onItemFadeChange} />
    </>
  );
}

function SolidColorField({ item, mixed, onChange }: { item: TimelineItem; mixed?: boolean; onChange: (key: string, value: unknown) => void }) {
  const t = useT();
  return (
    <>
      <SectionLabel>{t('纯色')}</SectionLabel>
      <label className="cc-insp-mg-field">
        <span>{t('填充颜色')}{mixed ? ' —' : ''}</span>
        <input type="color" value={String(item.props?.color ?? '#1a1a1a')} onChange={(event) => onChange('color', event.target.value)} />
      </label>
    </>
  );
}

function MotionGraphicFields({ item, schema, mixed, onChange }: {
  item: TimelineItem;
  schema: PropSpec[];
  mixed?: (key: string) => boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useT();
  if (schema.length === 0) return <div className="cc-insp-muted">{t('该模板无可编辑属性。')}</div>;
  return (
    <div className="cc-insp-mg-grid">
      {groupInspectorPropSchema(schema).map((group, groupIndex) => group.kind === 'color-row'
        ? <div className="cc-insp-color-row" key={`color-row:${groupIndex}`}>
          {group.fields.map((field) => <PropSchemaField
            key={field.key}
            spec={field}
            mixed={mixed?.(field.key)}
            value={item.props?.[field.key]}
            onChange={(value) => onChange(field.key, value)}
          />)}
        </div>
        : group.fields.map((field) => <PropSchemaField
          key={field.key}
          spec={field}
          mixed={mixed?.(field.key)}
          value={item.props?.[field.key]}
          onChange={(value) => onChange(field.key, value)}
        />))}
    </div>
  );
}

function InspectorHint({ item, count }: { item: TimelineItem; count: number }) {
  const t = useT();
  const labels: Partial<Record<TimelineItem['kind'], string>> = {
    audio: '音频',
    video: '视频',
    image: '图片',
    gif: 'GIF',
    svg: 'SVG',
    solid: '纯色',
    text: '文字',
    'motion-graphic': '动效图形',
    sequence: '嵌套序列',
  };
  const sourceBacked = ['audio', 'video', 'image', 'gif', 'svg'].includes(item.kind);
  return (
    <div className="cc-insp-scope">
      {count > 1 && <strong>{t('已选择 {n} 个片段', { n: count })}</strong>}
      <span className="cc-insp-scope-kind">{t(labels[item.kind] ?? '片段')}</span>
      <span>{sourceBacked
        ? t('仅作用于当前时间线片段，不修改媒体池中的源文件。')
        : t('仅作用于当前时间线片段。')}</span>
    </div>
  );
}
