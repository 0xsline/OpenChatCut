import { useRef } from 'react';
import type { TrackKind, TimelineState } from '../../editor/types';
import { timelineTrackIds, trackKind } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { Icon, type IconName } from '../icons';

const OPTIONS: Array<{ kind: TrackKind; label: string; icon: IconName }> = [
  { kind: 'video', label: '视频轨道', icon: 'film' },
  { kind: 'audio', label: '音频 / 音乐轨道', icon: 'volume' },
  { kind: 'caption', label: '字幕轨道', icon: 'captions' },
];

export function TrackCreateControl({ state, commands }: { state: TimelineState; commands: EditorCommands }) {
  const t = useT();
  const ref = useRef<HTMLDetailsElement>(null);
  const hasCaptionTrack = timelineTrackIds(state).some((id) => trackKind(state, id) === 'caption');
  const create = (kind: TrackKind) => {
    commands.createTrack(kind);
    if (ref.current) ref.current.open = false;
  };
  const createTimeline = () => {
    commands.createTimeline();
    if (ref.current) ref.current.open = false;
  };
  return (
    <details ref={ref} className="cc-track-create" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
    }}>
      <summary className="cc-tip" data-tip={t('新建轨道')} aria-label={t('新建轨道')}>
        <Icon name="plus" size={16} />
      </summary>
      <div className="cc-track-create-menu">
        <div className="cc-track-create-title">{t('新建轨道')}</div>
        {OPTIONS.map((option) => {
          const disabled = option.kind === 'caption' && hasCaptionTrack;
          return (
            <button key={option.kind} disabled={disabled} onClick={() => create(option.kind)}>
              <Icon name={option.icon} size={14} />
              <span>{t(option.label)}</span>
              {disabled && <small>{t('已存在')}</small>}
            </button>
          );
        })}
        <div className="cc-track-create-separator" />
        <button onClick={createTimeline}>
          <Icon name="plus" size={14} />
          <span>{t('新建序列')}</span>
        </button>
      </div>
    </details>
  );
}
