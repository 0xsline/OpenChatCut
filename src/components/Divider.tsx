import { useRef, useState } from 'react';
import { theme } from '../theme';

// A thin drag handle for resizing adjacent panels. Reports the pointer delta
// (along its axis) on each move; the parent clamps and applies it to a size.
export function Divider({ onResize, orientation = 'vertical' }: { onResize: (delta: number) => void; orientation?: 'vertical' | 'horizontal' }) {
  const last = useRef<number | null>(null);
  const [active, setActive] = useState(false);
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
        width: '100%', height: '100%', cursor: horiz ? 'row-resize' : 'col-resize',
        background: active ? theme.accent : theme.border,
        transition: active ? 'none' : 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.borderLight; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = theme.border; }}
    />
  );
}
