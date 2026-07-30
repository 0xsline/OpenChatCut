// Time ruler (moved verbatim from Timeline.tsx): click/hold drag seek; point in selection mode = time point,
// Drag = time period (startPick). The scale density changes with scaling to "good-looking" main scales; the I/O input and output flags are stacked on top.
// Mark the pin with the project level (click the pin to open the comment editor). The timecode span is written directly by the playhead painter to frames other than the initial value.
import { type RefObject } from 'react';
import { theme } from '../../theme';
import { MARKER_HEX, type Marker, type TimelineState } from '../../editor/types';
import type { TimelinePickDrag } from '../../agent/selection-refs';
import { useT } from '../../i18n/locale';
import {
  HEADER_W, RULER_H, fmtClock, fmtRuler, framePointInWindow, intersectFrameRange,
  rulerTickWindow, type TimelineFrameWindow,
} from './timelineUtil';

interface TimelineRulerProps {
  state: TimelineState;
  empty: boolean;
  px: number;
  majorFrames: number;
  minorFrames: number;
  minorTicksPerMajor: number;
  rulerEndFrame: number;
  visibleWindow: TimelineFrameWindow;
  pickMode: boolean;
  startPick: (e: React.PointerEvent, origin: TimelinePickDrag['origin']) => void;
  seekTo: (clientX: number) => void;
  rulerTimecodeRef: RefObject<HTMLSpanElement | null>;
  playheadFrame: number;
  zoneIn: number | null;
  zoneOut: number | null;
  markers: Marker[];
  onEditMarker: (id: string) => void;
  pinnedMarkerId: string | null;
}

export function TimelineRuler({
  state, empty, px, majorFrames, minorFrames, minorTicksPerMajor, rulerEndFrame, visibleWindow,
  pickMode, startPick, seekTo, rulerTimecodeRef, playheadFrame, zoneIn, zoneOut,
  markers, onEditMarker, pinnedMarkerId,
}: TimelineRulerProps) {
  const t = useT();
  const tickWindow = rulerTickWindow(visibleWindow, rulerEndFrame, majorFrames, minorTicksPerMajor);
  const visibleMarkers = markers.filter((marker) => marker.scope === 'project' && (
    marker.id === pinnedMarkerId
    || framePointInWindow(marker.fromFrame, visibleWindow)
    || !!intersectFrameRange(marker.fromFrame, marker.durationFrames, visibleWindow)
  ));
  const zoneRange = zoneIn != null && zoneOut != null && zoneOut > zoneIn
    ? intersectFrameRange(zoneIn, zoneOut - zoneIn, visibleWindow)
    : null;
  return (
    <div
      className="cc-timeline-ruler"
      onPointerDown={(e) => {
        if (pickMode) { startPick(e, 'ruler'); return; }
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId); // Press and drag = continuous seek; raise your hand to release automatically
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
          : Array.from({ length: tickWindow.majorCount }).map((_, offset) => {
              const i = tickWindow.firstMajor + offset * tickWindow.majorStride;
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
                    const minorOrdinal = i * minorTicksPerMajor + m;
                    if (minorOrdinal % tickWindow.minorStride !== 0) return null;
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
            {zoneRange && (
              <div
                title={t('入出点区间')}
                style={{
                  position: 'absolute', left: zoneRange.startFrame * px, top: 0, bottom: 0,
                  width: (zoneRange.endFrame - zoneRange.startFrame) * px,
                  background: 'rgba(88, 166, 255, 0.18)',
                  borderLeft: zoneRange.startFrame === zoneIn ? '2px solid #58a6ff' : undefined,
                  borderRight: zoneRange.endFrame === zoneOut ? '2px solid #58a6ff' : undefined,
                }}
              />
            )}
            {zoneIn != null && framePointInWindow(zoneIn, visibleWindow) && (
              <div title={t('入点 (I)')} style={{
                position: 'absolute', left: zoneIn * px, top: 2, transform: 'translateX(-50%)',
                width: 0, height: 0,
                // impeccable-disable-next-line side-tab -- CSS triangular flag (entry mark), non-card colored edge
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderTop: '8px solid #58a6ff',
              }} />
            )}
            {zoneOut != null && framePointInWindow(zoneOut, visibleWindow) && (
              <div title={t('出点 (O)')} style={{
                position: 'absolute', left: zoneOut * px, top: 2, transform: 'translateX(-50%)',
                width: 0, height: 0,
                // impeccable-disable-next-line side-tab -- CSS triangular flag (point mark), non-card colored edge
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderTop: '8px solid #f0883e',
              }} />
            )}
          </div>
        )}
        {/* Marker layer: bookmark pins over the ruler with range bars to the right. */}
        {visibleMarkers.map((marker) => {
          const range = marker.durationFrames > 0
            ? intersectFrameRange(marker.fromFrame, marker.durationFrames, visibleWindow)
            : null;
          const showPin = marker.id === pinnedMarkerId || framePointInWindow(marker.fromFrame, visibleWindow);
          const rootFrame = showPin ? marker.fromFrame : range?.startFrame ?? marker.fromFrame;
          return (
            <div key={marker.id} style={{ position: 'absolute', left: rootFrame * px, top: 0, zIndex: 4, pointerEvents: 'none' }}>
              {range && (
                <div style={{
                  position: 'absolute', left: (range.startFrame - rootFrame) * px, top: 12, height: 4,
                  width: Math.max(4, (range.endFrame - range.startFrame) * px),
                  background: MARKER_HEX[marker.color], borderRadius: 2, opacity: 0.85,
                }} />
              )}
              {showPin && (
                <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onEditMarker(marker.id)}
                  title={marker.note || t('标记')}
                  style={{ pointerEvents: 'auto', position: 'absolute', left: 0, top: -1, transform: 'translateX(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 0 }}>
                  <svg width="13" height="15" viewBox="0 0 24 24" fill={MARKER_HEX[marker.color]}
                    stroke="rgba(0,0,0,0.9)" strokeWidth="1.6" style={{ display: 'block' }}>
                    <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
