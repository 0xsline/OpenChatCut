import { useCallback, useEffect, useRef, useState } from 'react';

export interface AssetMenuPosition {
  top?: number;
  bottom?: number;
  left: number;
}

interface AssetMenuControl {
  assetId: string | null;
  position: AssetMenuPosition | null;
  open: (id: string, anchor: HTMLElement, point?: { x: number; y: number }) => void;
  close: (restoreFocus?: boolean) => void;
}

export function useAssetMenu(): AssetMenuControl {
  const [assetId, setAssetId] = useState<string | null>(null);
  const [position, setPosition] = useState<AssetMenuPosition | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const close = useCallback((restoreFocus = false) => {
    const anchor = anchorRef.current;
    setAssetId(null);
    setPosition(null);
    if (restoreFocus) queueMicrotask(() => anchor?.focus());
  }, []);

  useEffect(() => {
    if (!assetId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onViewportChange = () => close(true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('keydown', onKey);
    };
  }, [assetId, close]);

  const open = useCallback((id: string, anchor: HTMLElement, point?: { x: number; y: number }) => {
    if (assetId === id && !point) {
      close(true);
      return;
    }
    anchorRef.current = anchor;
    const rect = anchor.getBoundingClientRect();
    const panel = anchor.closest('.cc-media-pool')?.getBoundingClientRect();
    const menuWidth = 152;
    const anchorX = point?.x ?? rect.left;
    const anchorTop = point?.y ?? rect.top;
    const anchorBottom = point?.y ?? rect.bottom;
    const left = Math.min(
      (panel?.right ?? window.innerWidth) - menuWidth - 8,
      Math.max((panel?.left ?? 0) + 8, anchorX),
    );
    setAssetId(id);
    setPosition(anchorBottom > window.innerHeight / 2
      ? { bottom: window.innerHeight - anchorTop + 4, left }
      : { top: anchorBottom + 4, left });
  }, [assetId, close]);

  return { assetId, position, open, close };
}
