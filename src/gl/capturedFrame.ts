import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

// A render's decoded GL input frame, copied out of the decoder's onVideoFrame
// callback and tagged with the sequence frame it was decoded for. A GL pass
// draws only once every input holds THIS frame's pixels: a decoder element
// that merely reports itself ready may still show the previous frame.

export interface CapturedFrame {
  canvas: HTMLCanvasElement;
  /** Sequence frame the copy was decoded for. */
  frame: number;
}

export interface CapturedFrameInput {
  /** The input's latest captured frame; null until its decoder delivers one. */
  capturedRef: RefObject<CapturedFrame | null>;
  onVideoFrame: (source: CanvasImageSource) => void;
}

type SizedSource = CanvasImageSource & {
  videoWidth?: number;
  videoHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  width?: number;
  height?: number;
};

/** Intrinsic pixel size of anything a 2D canvas can draw. */
export function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  const sized = source as SizedSource;
  return {
    width: sized.videoWidth ?? sized.naturalWidth ?? sized.displayWidth ?? sized.width ?? 0,
    height: sized.videoHeight ?? sized.naturalHeight ?? sized.displayHeight ?? sized.height ?? 0,
  };
}

/**
 * Copy a decoded frame onto `canvas` at its intrinsic size. Decoders lend a
 * frame only briefly: @remotion/media closes its ImageBitmap as soon as
 * onVideoFrame returns, and <OffthreadVideo> revokes its image's blob URL when
 * the next frame is requested.
 */
export function copyFrame(canvas: HTMLCanvasElement, source: CanvasImageSource): void {
  const { width, height } = sourceSize(source);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (width && height) ctx.drawImage(source, 0, 0, width, height);
}

/**
 * The latest captured frame of one GL input and the onVideoFrame callback that
 * captures it. The callback keeps one identity for the component's lifetime:
 * <OffthreadVideo> reloads its image and @remotion/media re-extracts its frame
 * whenever onVideoFrame changes. It tags each copy with the frame committed
 * last; a render only moves to the next frame after this one's decode
 * delivered, so a copy can never carry a later frame's tag.
 */
export function useCapturedFrame(frame: number): CapturedFrameInput {
  const targetFrameRef = useRef(frame);
  const capturedRef = useRef<CapturedFrame | null>(null);
  useLayoutEffect(() => {
    targetFrameRef.current = frame;
  }, [frame]);
  const onVideoFrame = useCallback((source: CanvasImageSource) => {
    const canvas = capturedRef.current?.canvas ?? document.createElement('canvas');
    copyFrame(canvas, source);
    capturedRef.current = { canvas, frame: targetFrameRef.current };
  }, []);
  return { capturedRef, onVideoFrame };
}
