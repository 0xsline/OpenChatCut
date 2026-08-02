import { useLayoutEffect, useState, type ReactNode } from 'react';
import { theme, themeAlpha } from '../../theme';

export function ComposerPopover({ children, onClose, width, anchor }: {
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly width?: number;
  readonly anchor: HTMLElement | null;
}) {
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const popoverWidth = width ?? 220;
      setBox({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, width]);
  if (!box) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80 }} />
      <div style={{
        position: 'fixed', left: box.left, bottom: box.bottom, zIndex: 81,
        minWidth: width ?? 220, maxWidth: 300,
        maxHeight: Math.min(280, window.innerHeight - box.bottom - 16),
        overflowY: 'auto', background: theme.panelAlt,
        border: `0.5px solid ${theme.borderLight}`, borderRadius: 6,
        boxShadow: `0 12px 40px ${themeAlpha.shadow(0.5)}`, padding: 6,
      }}>
        {children}
      </div>
    </>
  );
}
