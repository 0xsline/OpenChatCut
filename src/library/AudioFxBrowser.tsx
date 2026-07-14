import { memo, useState } from 'react';
import type { TimelineItem } from '../editor/types';
import { isolateVoice } from '../audio/isolate';
import { Icon } from '../components/icons';

// Source Library "Audio" tab = Audio FX (人声隔离 / DeepFilterNet3).
// Wired to POST /api/isolate → item.denoisedSrc (playback prefers isolated audio).

export interface AudioFxItem {
  id: string;
  name: string;
  desc: string;
}

export const AUDIO_FX_ITEMS: AudioFxItem[] = [
  {
    id: 'audio-fx-denoise',
    name: '人声隔离',
    desc: '隔离视频或音频中的人声（源站 DeepFilterNet3；本机无 deep-filter 时用语音向 ffmpeg 回退）。',
  },
];

interface AudioFxBrowserProps {
  selectedItem: TimelineItem | null;
  onApply: (itemId: string, denoisedSrc: string, strength: number) => void;
  onClear: (itemId: string) => void;
}

export const AudioFxBrowser = memo(function AudioFxBrowser({
  selectedItem, onApply, onClear,
}: AudioFxBrowserProps) {
  const [busy, setBusy] = useState(false);
  const [strength, setStrength] = useState(100);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetOk =
    !!selectedItem
    && !!selectedItem.src
    && (selectedItem.kind === 'audio' || selectedItem.kind === 'video');
  const hasIsolated = !!(selectedItem?.denoisedSrc);

  const apply = async () => {
    if (!targetOk || !selectedItem?.src || busy) return;
    setBusy(true);
    setError(null);
    setNote('提取音频并隔离中…');
    try {
      const r = await isolateVoice(selectedItem.src, strength);
      onApply(selectedItem.id, r.path, r.strength);
      setNote(
        r.engine === 'deepfilternet3'
          ? `已应用 DeepFilterNet3（强度 ${r.strength}）`
          : `已应用语音向回退（${r.note ?? 'install deep-filter for source parity'}）`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setNote(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cc-audiofx-browser">
      <div className="cc-audiofx-hint">
        Audio FX · 人声隔离（源站 audio-fx）
        {!targetOk ? ' · 先在时间线选中带人声的音频/视频片段' : ` · 目标：${selectedItem?.name}`}
      </div>
      <div className="cc-audiofx-list">
        {AUDIO_FX_ITEMS.map((it) => (
          <div key={it.id} className={`cc-audiofx-card${targetOk ? '' : ' pending'}`}>
            <div className="cc-audiofx-thumb" aria-hidden>
              <Icon name="mic" size={22} />
            </div>
            <div className="cc-audiofx-body">
              <div className="cc-audiofx-name">
                {it.name}
                {hasIsolated && <span className="cc-audiofx-badge on">已应用</span>}
              </div>
              <div className="cc-audiofx-desc">{it.desc}</div>
              <label className="cc-audiofx-strength">
                强度 {strength}
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={strength}
                  disabled={busy}
                  onChange={(e) => setStrength(Number(e.target.value))}
                />
              </label>
              <div className="cc-audiofx-actions">
                <button
                  type="button"
                  className="cc-audiofx-btn primary"
                  disabled={!targetOk || busy}
                  onClick={() => void apply()}
                >
                  {busy ? '处理中…' : hasIsolated ? '重新隔离' : '应用到选中片段'}
                </button>
                {hasIsolated && selectedItem && (
                  <button
                    type="button"
                    className="cc-audiofx-btn"
                    disabled={busy}
                    onClick={() => {
                      onClear(selectedItem.id);
                      setNote('已恢复原始音频');
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {note && <div className="cc-audiofx-note ok">{note}</div>}
      {error && <div className="cc-audiofx-note err">{error}</div>}
      <div className="cc-audiofx-note">
        本 tab 对应源站 <code>audio-fx</code> / <code>isolate_voice</code>，不是 BGM。
        音乐请导入「我的素材」或 AI 生成。
      </div>
    </div>
  );
});
