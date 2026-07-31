import { useEffect, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { useT } from '../i18n/locale';
import { Icon } from './icons';
import { HistoryGestureProvider } from './inspector/InspectorKeyframeControls';
import { InspectorContent, type InspectorTab } from './inspector/InspectorContent';
import type { InspectorPanelProps } from './inspector/InspectorTypes';

function useInspectorPlayhead(getPlayhead: () => number, playerRef: RefObject<PlayerRef | null>): number {
  const [playhead, setPlayhead] = useState(getPlayhead);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return undefined;
    let lastUpdate = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const apply = (frame: number) => {
      lastUpdate = performance.now();
      setPlayhead((current) => current === frame ? current : frame);
    };
    const onFrame = (event: { detail: { frame: number } }) => {
      const wait = 100 - (performance.now() - lastUpdate);
      if (wait <= 0) {
        apply(event.detail.frame);
        return;
      }
      clearTimeout(trailing);
      trailing = setTimeout(() => apply(event.detail.frame), wait);
    };
    apply(player.getCurrentFrame());
    player.addEventListener('frameupdate', onFrame);
    return () => {
      clearTimeout(trailing);
      player.removeEventListener('frameupdate', onFrame);
    };
  }, [playerRef]);
  return playhead;
}

function InspectorHeader({ panel }: { panel: InspectorPanelProps }) {
  const t = useT();
  const item = panel.selectedItem;
  return (
    <button
      type="button"
      onClick={() => panel.onCollapsedChange(!panel.collapsed)}
      title={panel.collapsed ? t('展开属性') : t('收起属性')}
      className="cc-insp-header"
    >
      <span className={`cc-insp-chevron${panel.collapsed ? ' closed' : ''}`}><Icon name="chevronDown" size={12} /></span>
      <span className="cc-insp-heading">
        <span className="cc-insp-title">{t('片段属性')}</span>
        {item && <span className="cc-insp-title-name" title={item.name}>{item.name}</span>}
      </span>
      {item?.denoisedSrc && <span className="cc-insp-pill">{t('人声隔离')}</span>}
    </button>
  );
}

export function InspectorPanel(panel: InspectorPanelProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<InspectorTab>('basic');
  const playhead = useInspectorPlayhead(panel.getPlayhead, panel.playerRef);
  const item = panel.selectedItem;
  const schema = item ? panel.templates.find((template) => template.id === item.templateId)?.propSchema ?? [] : [];
  const rawLocalFrame = item ? Math.round(playhead) - item.startFrame : 0;
  const playheadLocal = {
    localFrame: item ? Math.max(0, Math.min(item.durationInFrames - 1, rawLocalFrame)) : 0,
    inRange: !!item && rawLocalFrame >= 0 && rawLocalFrame < item.durationInFrames,
  };
  return (
    <HistoryGestureProvider value={panel.historyGesture}>
      <section className={`cc-inspector${panel.collapsed ? ' collapsed' : ''}`}>
        <InspectorHeader panel={panel} />
        {!panel.collapsed && (item
          ? <InspectorContent panel={panel} item={item} schema={schema} playheadLocal={playheadLocal} activeTab={activeTab} onTabChange={setActiveTab} />
          : <div className="cc-insp-body"><div className="cc-insp-muted">{t('选中时间线上的片段以编辑属性。')}</div></div>)}
      </section>
    </HistoryGestureProvider>
  );
}
