import { useEffect, useId, type KeyboardEvent } from 'react';
import type { PropSpec } from '../../types';
import type { TimelineItem } from '../../editor/types';
import { KEYFRAME_PROPS, getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { useT } from '../../i18n/locale';
import { PropSchemaField } from './PropSchemaField';
import { TransformControl, VolumeControl } from './InspectorKeyframeControls';
import { FadeControl, IsolateVoiceControl, SpeedControl, TextControl, TransitionControl, ZoomControl } from './InspectorMediaControls';
import { EffectsControl, FilterControl, SectionLabel } from './InspectorVisualControls';
import type { InspectorPanelProps } from './InspectorTypes';

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


export function InspectorContent(props: InspectorContentProps) {
  const { item, activeTab, onTabChange } = props;
  const tabGroupId = useId();
  const available: Record<InspectorTab, boolean> = {
    basic: true,
    video: item.kind !== 'audio',
    audio: item.kind === 'audio' || item.kind === 'video',
    animation: true,
  };
  useEffect(() => {
    const unavailable = activeTab === 'video'
      ? item.kind === 'audio'
      : activeTab === 'audio' && item.kind !== 'audio' && item.kind !== 'video';
    if (unavailable) onTabChange('basic');
  }, [activeTab, item.kind, onTabChange]);
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
          <InspectorHint item={item} />
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
      {item.kind === 'text' && <><SectionLabel>{t('文字')}</SectionLabel><TextControl item={item} onPropChange={panel.onItemPropChange} /></>}
      {item.kind !== 'audio' && <><SectionLabel onReset={() => panel.onResetItemKeyframes(transformProps)} resetDisabled={resetDisabled}>{t('变换')}</SectionLabel><TransformControl item={item} onChange={panel.onItemTransformChange} onReset={panel.onResetItemKeyframes} kf={{
        ...playheadLocal,
        set: panel.onSetItemKeyframe,
        remove: panel.onRemoveItemKeyframe,
        seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
      }} /></>}
      {item.kind === 'solid' && <SolidColorField item={item} onChange={panel.onItemPropChange} />}
      {item.kind === 'motion-graphic' && <MotionGraphicFields item={item} schema={schema} onChange={panel.onItemPropChange} />}
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
  return (
    <>
      <SectionLabel onReset={() => panel.onItemFiltersChange({ brightness: 1, contrast: 1, saturate: 1, blur: 0 })} resetDisabled={resetDisabled}>{t('滤镜')}</SectionLabel>
      <FilterControl item={item} onChange={panel.onItemFiltersChange} autoGrade={panel.autoGrade} />
      {(item.kind === 'video' || item.kind === 'image') && <><SectionLabel>{t('特效')}</SectionLabel><EffectsControl item={item} onChange={panel.onItemEffectsChange} /></>}
    </>
  );
}

function AudioTab({ panel, item, playheadLocal }: InspectorContentProps) {
  const t = useT();
  return (
    <>
      <SectionLabel>{t('音量')}</SectionLabel>
      <VolumeControl item={item} onChange={panel.onItemVolumeChange} onNormalize={panel.onNormalizeLoudness} onReset={panel.onResetItemKeyframes} kf={{
        ...playheadLocal,
        set: panel.onSetItemKeyframe,
        remove: panel.onRemoveItemKeyframe,
        seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
      }} />
      {panel.onIsolateVoice && <><SectionLabel>{t('人声隔离')}</SectionLabel><IsolateVoiceControl item={item} onIsolate={panel.onIsolateVoice} /></>}
    </>
  );
}

function AnimationTab({ panel, item }: InspectorContentProps) {
  const t = useT();
  const visual = item.kind !== 'audio';
  return (
    <>
      {(item.kind === 'video' || item.kind === 'audio') && panel.onItemSpeedChange && <><SectionLabel>{t('变速')}</SectionLabel><SpeedControl item={item} onChange={panel.onItemSpeedChange} /></>}
      {visual && <><SectionLabel onReset={() => panel.onItemZoomChange(null)} resetDisabled={!item.zoom}>{t('缩放')}</SectionLabel><ZoomControl zoom={item.zoom} onChange={panel.onItemZoomChange} getLocalFrame={() => Math.max(0, Math.min(item.durationInFrames - 1, panel.getPlayhead() - item.startFrame))} fps={panel.fps} onSetKeyframe={panel.onSetReframeKeyframe} onRemoveKeyframe={panel.onRemoveReframeKeyframe} /></>}
      {visual && <><SectionLabel>{t('转场')}</SectionLabel><TransitionControl transition={panel.transition} fps={panel.fps} onAdd={panel.onAddTransition} onSet={panel.onSetTransition} onRemove={panel.onRemoveTransition} audioMode={false} /></>}
      {item.kind === 'audio' && <><SectionLabel>{t('音频转场')}</SectionLabel><TransitionControl transition={panel.transition} fps={panel.fps} onAdd={panel.onAddTransition} onSet={panel.onSetTransition} onRemove={panel.onRemoveTransition} audioMode /></>}
      <SectionLabel onReset={() => panel.onItemFadeChange({ fadeInFrames: 0, fadeOutFrames: 0 })} resetDisabled={(item.fadeInFrames ?? 0) === 0 && (item.fadeOutFrames ?? 0) === 0}>{t('淡入淡出')}</SectionLabel>
      <FadeControl item={item} fps={panel.fps} onChange={panel.onItemFadeChange} />
    </>
  );
}

function SolidColorField({ item, onChange }: { item: TimelineItem; onChange: (key: string, value: unknown) => void }) {
  const t = useT();
  return (
    <>
      <SectionLabel>{t('纯色')}</SectionLabel>
      <label className="cc-insp-mg-field">
        <span>{t('填充颜色')}</span>
        <input type="color" value={String(item.props?.color ?? '#1a1a1a')} onChange={(event) => onChange('color', event.target.value)} />
      </label>
    </>
  );
}

function MotionGraphicFields({ item, schema, onChange }: {
  item: TimelineItem;
  schema: PropSpec[];
  onChange: (key: string, value: unknown) => void;
}) {
  const t = useT();
  if (schema.length === 0) return <div className="cc-insp-muted">{t('该模板无可编辑属性。')}</div>;
  return (
    <div className="cc-insp-mg-grid">
      {schema.map((field, index) => <PropSchemaField
        key={`${index}:${field.key}`}
        spec={field}
        value={item.props?.[field.key]}
        onChange={(value) => onChange(field.key, value)}
      />)}
    </div>
  );
}

function InspectorHint({ item }: { item: TimelineItem }) {
  const t = useT();
  const labels: Partial<Record<TimelineItem['kind'], string>> = {
    audio: t('音频片段。可在时间线上拖动位置、裁剪首尾。'),
    video: t('视频片段。可在时间线上拖动位置、裁剪首尾（左裁剪推进源入点）。'),
    image: t('图片片段。'),
    gif: t('GIF 片段。'),
    svg: t('SVG 片段。'),
    solid: t('纯色片段。'),
    text: t('文字片段。'),
  };
  const label = labels[item.kind];
  return label ? <div className="cc-insp-hint">{label}</div> : null;
}
