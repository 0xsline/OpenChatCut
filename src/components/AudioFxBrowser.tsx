import { memo } from 'react';
import { Icon } from './icons';

// Source Library "Audio" tab = Audio FX presets (not BGM).
// Source ships AI Voice Isolation (人声隔离 / DeepFilterNet3) as the only
// public audio-fx entry; browse_library reports the catalog as empty until
// more track FX land. Clone does not wire isolate_voice yet — show the card
// disabled with a clear source-parity note so the tab is not confused with music.

export interface AudioFxItem {
  id: string;
  name: string;
  desc: string;
  ready: boolean;
}

export const AUDIO_FX_ITEMS: AudioFxItem[] = [
  {
    id: 'audio-fx-denoise',
    name: '人声隔离',
    desc: '隔离视频或音频片段中的人声（源站 DeepFilterNet3）。克隆尚未接入 apply 流水线。',
    ready: false,
  },
];

interface AudioFxBrowserProps {
  /** currently selected timeline item kind, for target hint */
  hasAudioTarget: boolean;
  onApply?: (id: string) => void;
}

export const AudioFxBrowser = memo(function AudioFxBrowser({ hasAudioTarget, onApply }: AudioFxBrowserProps) {
  return (
    <div className="cc-audiofx-browser">
      <div className="cc-audiofx-hint">
        Audio FX · 源站目前公开条目：人声隔离
        {!hasAudioTarget ? ' · 先在时间线选中带音频的片段' : ''}
      </div>
      <div className="cc-audiofx-list">
        {AUDIO_FX_ITEMS.map((it) => {
          const clickable = it.ready && hasAudioTarget;
          return (
            <button
              key={it.id}
              type="button"
              className={`cc-audiofx-card${it.ready ? '' : ' pending'}`}
              aria-disabled={!clickable}
              disabled={!clickable}
              title={it.ready ? `应用：${it.name}` : `${it.name}（尚未接入）`}
              onClick={() => {
                if (clickable) onApply?.(it.id);
              }}
            >
              <div className="cc-audiofx-thumb" aria-hidden>
                <Icon name="mic" size={22} />
              </div>
              <div className="cc-audiofx-body">
                <div className="cc-audiofx-name">
                  {it.name}
                  {!it.ready && <span className="cc-audiofx-badge">即将接入</span>}
                </div>
                <div className="cc-audiofx-desc">{it.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="cc-audiofx-note">
        说明：本 tab 对应源站 <code>audio-fx</code>（Audio FX），不是 BGM 音乐库。
        背景音乐请用 AI 生成或导入到「我的素材」。
      </div>
    </div>
  );
});
