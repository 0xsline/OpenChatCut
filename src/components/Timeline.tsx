import { theme } from '../theme';
import type { Tpl } from '../types';

interface TimelineProps {
  /** the template currently shown as a clip on V1 */
  clip: Tpl;
}

const TRACKS = [
  { id: 'V2', color: theme.trackVideo, kind: 'video' as const },
  { id: 'V1', color: theme.trackVideo, kind: 'video' as const },
  { id: 'A1', color: theme.trackAudioA1, kind: 'audio' as const },
  { id: 'A2', color: theme.trackAudioA2, kind: 'audio' as const },
];

const HEADER_W = 120;
const PX_PER_FRAME = 6; // zoom

const toolBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 15, padding: '2px 6px' };

function fmt(frames: number, fps: number): string {
  const s = frames / fps;
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.floor((s * 100) % 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function Timeline({ clip }: TimelineProps) {
  const clipW = clip.durationInFrames * PX_PER_FRAME;
  return (
    <section style={{ borderTop: `1px solid ${theme.border}`, background: theme.panel, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: `1px solid ${theme.border}` }}>
        <button style={toolBtn}>＋</button>
        <button style={toolBtn}>▮</button>
        <button style={{ ...toolBtn, color: theme.accent }}>⧉</button>
        <button style={toolBtn}>▬</button>
        <button style={toolBtn}>✂</button>
        <button style={toolBtn}>✎</button>
        <span style={{ width: 12 }} />
        <button style={toolBtn}>🎙</button>
        <span style={{ flex: 1 }} />
        <button style={toolBtn}>▶</button>
        <span style={{ fontSize: 12, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>
          00:00.00 / {fmt(clip.durationInFrames, clip.fps)}
        </span>
        <span style={{ flex: 1 }} />
        <button style={toolBtn}>🔍−</button>
        <button style={toolBtn}>🔍＋</button>
        <button style={toolBtn}>⇔</button>
        <button style={toolBtn}>CC</button>
      </div>

      {/* ruler */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${theme.border}`, fontSize: 10, color: theme.textDim }}>
        <div style={{ width: HEADER_W, flexShrink: 0, textAlign: 'center', padding: '4px 0' }}>{fmt(0, clip.fps)}</div>
        <div style={{ flex: 1, position: 'relative', height: 22, overflow: 'hidden' }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ position: 'absolute', left: i * clip.fps * 2 * PX_PER_FRAME, top: 4 }}>
              {String(i * 2).padStart(2, '0')}:00:00
            </span>
          ))}
        </div>
      </div>

      {/* tracks */}
      <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {TRACKS.map((tr) => (
          <div key={tr.id} style={{ display: 'flex', height: 56, borderBottom: `1px solid ${theme.border}` }}>
            {/* header */}
            <div style={{ width: HEADER_W, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderRight: `1px solid ${theme.border}` }}>
              <span style={{ background: tr.color, color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 4, padding: '2px 6px' }}>{tr.id}</span>
              <span style={{ color: theme.textDim, fontSize: 12 }}>👁</span>
              <span style={{ color: theme.textDim, fontSize: 12 }}>🔊</span>
            </div>
            {/* lane */}
            <div style={{ flex: 1, position: 'relative', background: theme.bg }}>
              {tr.id === 'V1' && (
                <div
                  title={clip.name}
                  style={{
                    position: 'absolute', left: 4, top: 6, height: 44, width: clipW,
                    background: theme.clipVideo, borderRadius: 5, color: '#fff', fontSize: 11,
                    display: 'flex', alignItems: 'center', padding: '0 8px', gap: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                  }}
                >
                  <span>✦</span>{clip.name}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
