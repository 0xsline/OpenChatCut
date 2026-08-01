import { useRef, useState } from 'react';
import { theme } from '../theme';
import { useT } from '../i18n/locale';

// A thin drag handle for resizing adjacent panels. Reports the pointer delta
// (along its axis) on each move; the parent clamps and applies it to a size.
export function Divider({ onResize, orientation = 'vertical' }: { onResize: (delta: number) => void; orientation?: 'vertical' | 'horizontal' }) {
  const t = useT();
  const last = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const horiz = orientation === 'horizontal';
  const axis = (e: React.PointerEvent) => (horiz ? e.clientY : e.clientX);

  return (
    <div
      className="cc-panel-divider"
      role="separator"
      tabIndex={0}
      aria-orientation={horiz ? 'horizontal' : 'vertical'}
      aria-label={t('拖动调整大小')}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = axis(e);
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (last.current == null) return;
        const cur = axis(e);
        const d = cur - last.current;
        last.current = cur;
        if (d) onResize(d);
      }}
      onPointerUp={(e) => {
        last.current = null;
        setActive(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        const delta = horiz
          ? event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
          : event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        if (!delta) return;
        event.preventDefault();
        onResize(delta);
      }}
      title={t('拖动调整大小')}
      style={{
        position: 'relative', zIndex: 20,
        width: horiz ? '100%' : 9, height: horiz ? 9 : '100%',
        left: horiz ? 0 : -4, top: horiz ? -4 : 0,
        cursor: horiz ? 'row-resize' : 'col-resize',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{
        position: 'absolute', pointerEvents: 'none',
        left: horiz ? 0 : 4, top: horiz ? 4 : 0,
        // Visible line stays 0.5px (one physical pixel on Retina); the hit area
        // is deliberately wider for touchpads and high-density screens.
        width: horiz ? '100%' : 0.5, height: horiz ? 0.5 : '100%',
        background: active ? theme.accent : hovered ? theme.borderLight : theme.border,
      }} />
    </div>
  );
}
