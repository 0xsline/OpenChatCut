// 时间标尺(逐字搬自 Timeline.tsx):点击/按住拖动 seek;选择模式下点=时间点、
// 拖=时间段(startPick)。刻度密度随缩放取「好看的」主刻度;上面叠 I/O 入出点旗
// 与项目级标记图钉(点图钉开批注编辑器)。时码 span 由播放头绘制器直写初值以外的帧。
import { type RefObject } from 'react';
import { theme } from '../../theme';
import { MARKER_HEX, type Marker, type TimelineState } from '../../editor/types';
import type { TimelinePickDrag } from '../../agent/selection-refs';
import { useT } from '../../i18n/locale';
import { HEADER_W, RULER_H, fmtClock, fmtRuler } from './timelineUtil';

interface TimelineRulerProps {
  state: TimelineState;
  empty: boolean;
  px: number;
  majorCount: number;
  majorFrames: number;
  minorFrames: number;
  minorTicksPerMajor: number;
  pickMode: boolean;
  startPick: (e: React.PointerEvent, origin: TimelinePickDrag['origin']) => void;
  seekTo: (clientX: number) => void;
  rulerTimecodeRef: RefObject<HTMLSpanElement | null>;
  playheadFrame: number;
  zoneIn: number | null;
  zoneOut: number | null;
  markers: Marker[];
  onEditMarker: (id: string) => void;
}

export function TimelineRuler({
  state, empty, px, majorCount, majorFrames, minorFrames, minorTicksPerMajor,
  pickMode, startPick, seekTo, rulerTimecodeRef, playheadFrame, zoneIn, zoneOut, markers, onEditMarker,
}: TimelineRulerProps) {
  const t = useT();
  return (
    <div
      className="cc-timeline-ruler"
      onPointerDown={(e) => {
        if (pickMode) { startPick(e, 'ruler'); return; }
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId); // 按住拖动=连续 seek;抬手自动释放
        e.currentTarget.style.cursor = 'grabbing';
        seekTo(e.clientX);
      }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX); }}
      onPointerUp={(e) => { e.currentTarget.style.cursor = ''; }}
      style={{ display: 'flex', height: RULER_H, borderBottom: `0.5px solid ${theme.border}`, fontSize: 10, color: theme.textDim, cursor: pickMode ? 'crosshair' : 'pointer', userSelect: 'none' }}
    >
      <div className="cc-ruler-head" style={{ width: HEADER_W }}><span ref={rulerTimecodeRef}>{fmtClock(playheadFrame, state.fps)}</span></div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        {empty
          ? Array.from({ length: 5 }).map((_, i) => (
              <span key={i} style={{ position: 'absolute', left: `${i * 25}%`, top: 6, transform: i === 4 ? 'translateX(-100%)' : undefined }}>{fmtRuler(i * state.fps * 10, state.fps)}</span>
            ))
          : Array.from({ length: majorCount }).map((_, i) => {
              const f = i * majorFrames;
              const left = f * px;
              return (
                <div key={i} style={{ position: 'absolute', left, top: 0, height: '100%', pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', left: 0, bottom: 0, width: 1, height: 10, background: theme.borderLight }} />
                  <span style={{ position: 'absolute', left: 4, top: 5, whiteSpace: 'nowrap', color: theme.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtRuler(f, state.fps)}
                  </span>
                  {/* minor ticks between majors (density scales with zoom) */}
                  {Array.from({ length: minorTicksPerMajor }).map((__, m) => {
                    const mf = f + (m + 1) * minorFrames;
                    if (mf >= f + majorFrames) return null;
                    const mid = m + 1 === Math.round(minorTicksPerMajor / 2);
                    return (
                      <div
                        key={m}
                        style={{
                          position: 'absolute',
                          left: (m + 1) * minorFrames * px,
                          bottom: 0,
                          width: 1,
                          height: mid ? 7 : 4,
                          background: mid ? theme.borderLight : theme.border,
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
        {/* I/O mark-in/mark-out zone */}
        {(zoneIn != null || zoneOut != null) && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
            {zoneIn != null && zoneOut != null && zoneOut > zoneIn && (
              <div
                title={t('入出点区间')}
                style={{
                  position: 'absolute', left: zoneIn * px, top: 0, bottom: 0,
                  width: (zoneOut - zoneIn) * px,
                  background: 'rgba(88, 166, 255, 0.18)',
                  borderLeft: '2px solid #58a6ff',
                  borderRight: '2px solid #58a6ff',
                }}
              />
            )}
            {zoneIn != null && (
              <div title={t('入点 (I)')} style={{
                position: 'absolute', left: zoneIn * px, top: 2, transform: 'translateX(-50%)',
                width: 0, height: 0,
                // impeccable-disable-next-line side-tab -- CSS 三角形小旗(入点标记),非卡片彩边
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderTop: '8px solid #58a6ff',
              }} />
            )}
            {zoneOut != null && (
              <div title={t('出点 (O)')} style={{
                position: 'absolute', left: zoneOut * px, top: 2, transform: 'translateX(-50%)',
                width: 0, height: 0,
                // impeccable-disable-next-line side-tab -- CSS 三角形小旗(出点标记),非卡片彩边
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderTop: '8px solid #f0883e',
              }} />
            )}
          </div>
        )}
        {/* Marker layer: bookmark pins over the ruler with range bars to the right. */}
        {markers.filter((m) => m.scope === 'project').map((m) => (
          <div key={m.id} style={{ position: 'absolute', left: m.fromFrame * px, top: 0, zIndex: 4, pointerEvents: 'none' }}>
            {m.durationFrames > 0 && (
              <div style={{ position: 'absolute', left: 0, top: 12, height: 4, width: Math.max(4, m.durationFrames * px), background: MARKER_HEX[m.color], borderRadius: 2, opacity: 0.85 }} />
            )}
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onEditMarker(m.id)} title={m.note || t('标记')}
              style={{ pointerEvents: 'auto', position: 'absolute', left: 0, top: -1, transform: 'translateX(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 0 }}>
              <svg width="13" height="15" viewBox="0 0 24 24" fill={MARKER_HEX[m.color]} stroke="rgba(0,0,0,0.9)" strokeWidth="1.6" style={{ display: 'block' }}>
                <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
