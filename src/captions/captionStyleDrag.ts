import type { CaptionTemplate } from './types';

export const CAPTION_STYLE_POINTER_DROP_EVENT = 'cc:caption-style-pointer-drop';

const POINTER_DRAG_THRESHOLD = 6;

export interface CaptionStyleDragPayload {
  trackId: string;
  template: CaptionTemplate;
}

export interface CaptionStylePointerDrop {
  clientX: number;
  clientY: number;
  payload: CaptionStyleDragPayload;
}

export function beginCaptionStylePointerDrag(
  start: Pick<PointerEvent, 'button' | 'clientX' | 'clientY' | 'pointerId'>,
  payload: CaptionStyleDragPayload,
): void {
  if (start.button !== 0) return;
  let moved = false;
  const matches = (event: PointerEvent) => event.pointerId === start.pointerId;
  const cleanup = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
  };
  const onMove = (event: PointerEvent) => {
    if (!matches(event)) return;
    moved ||= Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= POINTER_DRAG_THRESHOLD;
  };
  const onUp = (event: PointerEvent) => {
    if (!matches(event)) return;
    cleanup();
    if (!moved) return;
    window.dispatchEvent(new CustomEvent<CaptionStylePointerDrop>(CAPTION_STYLE_POINTER_DROP_EVENT, {
      detail: { clientX: event.clientX, clientY: event.clientY, payload },
    }));
  };
  const onCancel = (event: PointerEvent) => { if (matches(event)) cleanup(); };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
}

export function onCaptionStylePointerDrop(listener: (drop: CaptionStylePointerDrop) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<CaptionStylePointerDrop>).detail);
  window.addEventListener(CAPTION_STYLE_POINTER_DROP_EVENT, handler);
  return () => window.removeEventListener(CAPTION_STYLE_POINTER_DROP_EVENT, handler);
}
