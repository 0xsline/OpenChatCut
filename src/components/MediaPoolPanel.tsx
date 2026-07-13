import { useRef, useState } from 'react';
import { theme } from '../theme';
import type { MediaAsset } from '../editor/types';

interface MediaPoolPanelProps {
  assets: MediaAsset[];
  fps: number;
  onImport: (file: File) => Promise<void>;
  onAddAsset: (asset: MediaAsset) => void;
}

// 「我的素材」— import local video/image/audio, then click to place on the timeline.
export function MediaPoolPanel({ assets, fps, onImport, onAddAsset }: MediaPoolPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) await onImport(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 12, gap: 10 }}>
      <input ref={inputRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(e) => onPick(e.target.files)} />
      <button onClick={() => inputRef.current?.click()} disabled={busy}
        style={{ border: `1px dashed ${theme.border}`, background: theme.panelAlt, color: theme.text, borderRadius: 8, padding: '12px', fontSize: 13, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
        {busy ? '导入中…' : '＋ 导入素材（视频 / 图片 / 音频）'}
      </button>
      {error && <div style={{ fontSize: 11, color: '#f88' }}>{error}</div>}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {assets.length === 0 ? (
          <div style={{ color: theme.textDim, fontSize: 12, padding: '8px 2px', lineHeight: 1.6 }}>
            还没有素材。点上方导入本地视频/图片/音频，再点缩略图加到时间线。
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 8 }}>{assets.length} 个素材 · 点击加到时间线</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
              {assets.map((a) => (
                <button key={a.id} onClick={() => onAddAsset(a)} title={`加到时间线：${a.name}`}
                  style={{ cursor: 'pointer', textAlign: 'left', padding: 0, overflow: 'hidden', border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.panelAlt, color: theme.text }}>
                  <div style={{ aspectRatio: '16 / 9', background: '#0c0c0c', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                    {a.kind === 'image' ? (
                      <img src={a.src} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : a.kind === 'video' ? (
                      <video src={a.src} muted preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span style={{ fontSize: 24 }}>🎵</span>
                    )}
                  </div>
                  <div style={{ padding: '5px 7px', display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                    <span style={{ fontSize: 10, color: theme.textDim, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{(a.durationInFrames / fps).toFixed(1)}s</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
