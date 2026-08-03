import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { theme, themeAlpha } from '../../theme';
import { placeChatPopover, type ChatPopoverPlacement, type PopoverRect } from './chatPopoverGeometry';

interface ComposerPopoverProps {
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly width?: number;
  readonly anchor: HTMLElement | null;
  readonly className?: string;
  readonly ariaLabel?: string;
}

function viewportBoundary(): PopoverRect {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** Keep fixed composer menus inside the Agent workspace that owns the trigger. */
export function ComposerPopover({
  children,
  onClose,
  anchor,
  width = 220,
  className,
  ariaLabel,
}: ComposerPopoverProps) {
  const [box, setBox] = useState<ChatPopoverPlacement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const boundary = anchor.closest<HTMLElement>('[data-cc-chat-popover-boundary]');
    const place = () => {
      setBox(placeChatPopover({
        anchor: anchor.getBoundingClientRect(),
        boundary: boundary?.getBoundingClientRect() ?? viewportBoundary(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        requestedWidth: width,
      }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(anchor);
    if (boundary && boundary !== anchor) observer?.observe(boundary);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer?.disconnect();
    };
  }, [anchor, width]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!box) return null;
  return (
    <>
      <div className="cc-chat-popover-backdrop" onPointerDown={onClose} />
      <div
        className={`cc-chat-popover${className ? ` ${className}` : ''}`}
        role="menu"
        aria-label={ariaLabel}
        style={{
          left: box.left,
          bottom: box.bottom,
          width: box.width,
          minWidth: box.width,
          maxWidth: box.width,
          maxHeight: box.maxHeight,
          background: theme.panelAlt,
          borderColor: theme.borderLight,
          boxShadow: `0 12px 40px ${themeAlpha.shadow(0.5)}`,
        }}
      >
        {children}
      </div>
    </>
  );
}
