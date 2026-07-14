import { useRef, useState } from 'react';
import { theme } from '../theme';

// A thin drag handle for resizing adjacent panels. Reports the pointer delta
// (along its axis) on each move; the parent clamps and applies it to a size.
export function Divider({ onResize, orientation = 'vertical' }: { onResize: (delta: number) => void; orientation?: 'vertical' | 'horizontal' }) {
  const last = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const horiz = orientation === 'horizontal';
  const axis = (e: React.PointerEvent) => (horiz ? e.clientY : e.clientX);

  return (
    <div
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
      title="拖动调整大小"
      style={{
        position: 'relative', zIndex: 20,
        width: horiz ? '100%' : 5, height: horiz ? 5 : '100%',
        left: horiz ? 0 : -2, top: horiz ? -2 : 0,
        cursor: horiz ? 'row-resize' : 'col-resize',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{
        position: 'absolute', pointerEvents: 'none',
        left: horiz ? 0 : 2, top: horiz ? 2 : 0,
        width: horiz ? '100%' : 1, height: horiz ? 1 : '100%',
        background: active ? theme.accent : hovered ? theme.borderLight : theme.border,
      }} />
    </div>
  );
}
