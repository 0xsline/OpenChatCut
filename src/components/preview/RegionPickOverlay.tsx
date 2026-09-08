import { useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineState } from '../../editor/types';
import { canvasRegionRef, emitSelectionRef, regionFromDrag } from '../../agent/selection-refs';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';

// Selection-mode marquee over the video rect: drag a rectangle → canvas-region
// reference in COMPOSITION coordinates, with the visual clips it covers at the
// current frame (emits openchatcut:canvas-region-marked).
export function RegionPickOverlay({ state, playerRef }: { state: TimelineState; playerRef: RefObject<PlayerRef | null> }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pos = (event: React.PointerEvent) => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    };
  };
  return (
    <div
      ref={boxRef}
      title={t('拖拽框选画面区域作为引用')}
      onPointerDown={(event) => {
        if (event.button !== 0) return; // left button only
        event.currentTarget.setPointerCapture(event.pointerId);
        const p = pos(event);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        const p = pos(event);
        setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
      }}
      onPointerUp={() => {
        if (!drag || !boxRef.current) return;
        const rect = boxRef.current.getBoundingClientRect();
        const region = regionFromDrag(
          { x: drag.x0, y: drag.y0 }, { x: drag.x1, y: drag.y1 },
          rect.width, rect.height, state.width, state.height,
        );
        if (region) {
          emitSelectionRef(canvasRegionRef(region, Math.round(playerRef.current?.getCurrentFrame() ?? 0), state));
        }
        setDrag(null);
      }}
      style={{ position: 'absolute', inset: 0, zIndex: 5, cursor: 'crosshair', touchAction: 'none' }}
    >
      {drag && (
        <div style={{
          position: 'absolute',
          left: Math.min(drag.x0, drag.x1),
          top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
          border: `0.5px solid ${theme.accent}`,
          background: themeAlpha.accent(0.14), // theme.accent @ 14%
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
}
