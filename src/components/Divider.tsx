import { useRef, useState } from 'react';
import { theme } from '../theme';

// A thin vertical drag handle for resizing adjacent panels. Reports the pointer
// delta on each move; the parent clamps and applies it to a column width.
export function Divider({ onResize }: { onResize: (deltaX: number) => void }) {
  const last = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  return (
    <div
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = e.clientX;
        setActive(true);
      }}
      onPointerMove={(e) => {
        if (last.current == null) return;
        const dx = e.clientX - last.current;
        last.current = e.clientX;
        if (dx) onResize(dx);
      }}
      onPointerUp={(e) => {
        last.current = null;
        setActive(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      title="拖动调整宽度"
      style={{
        width: '100%', height: '100%', cursor: 'col-resize',
        background: active ? theme.accent : theme.border,
        transition: active ? 'none' : 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.borderLight; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = theme.border; }}
    />
  );
}
