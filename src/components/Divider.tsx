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
      title={t('拖动调整大小')}
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
        // 可见线走 0.5px 发丝(Retina 上 1 物理像素);5px 命中区不变
        width: horiz ? '100%' : 0.5, height: horiz ? 0.5 : '100%',
        background: active ? theme.accent : hovered ? theme.borderLight : theme.border,
      }} />
    </div>
  );
}
