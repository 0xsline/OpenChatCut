// Shared photoreal sample frames for library-card previews (FX / LUT / zoom /
// transitions). Loaded on demand from /library-previews/*.jpg into a bounded,
// releasable decoded-canvas cache for WebGL TexImageSource input.

export const SAMPLE_W = 320;
export const SAMPLE_H = 180;

const SRC = {
  fx: '/library-previews/sample-fx.jpg?v=tokyo-tower-1', // Tokyo Tower — FX / LUT / zoom
  out: '/library-previews/sample-out.jpg', // outdoor street — transition A
  in: '/library-previews/sample-in.jpg',   // warm interior — transition B
} as const;

export type SampleFrameKind = keyof typeof SRC;

const MAX_DECODED_ENTRIES = 3;
const FRAME_BYTES = SAMPLE_W * SAMPLE_H * 4;
const MAX_DECODED_BYTES = MAX_DECODED_ENTRIES * FRAME_BYTES;
const canvases = new Map<SampleFrameKind, HTMLCanvasElement>();
const loaders = new Map<SampleFrameKind, Promise<HTMLCanvasElement>>();
const generations: Record<SampleFrameKind, number> = { fx: 0, out: 0, in: 0 };

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const scale = Math.max(SAMPLE_W / iw, SAMPLE_H / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (SAMPLE_W - dw) / 2, (SAMPLE_H - dh) / 2, dw, dh);
}

function rememberCanvas(kind: SampleFrameKind, canvas: HTMLCanvasElement): void {
  const previous = canvases.get(kind);
  if (previous) {
    canvases.delete(kind);
    if (previous !== canvas) {
      previous.width = 0;
      previous.height = 0;
    }
  }
  canvases.set(kind, canvas);
  while (canvases.size > MAX_DECODED_ENTRIES || canvases.size * FRAME_BYTES > MAX_DECODED_BYTES) {
    const oldest = canvases.keys().next().value as SampleFrameKind | undefined;
    if (!oldest) break;
    const evicted = canvases.get(oldest);
    canvases.delete(oldest);
    if (evicted) {
      evicted.width = 0;
      evicted.height = 0;
    }
  }
}

function loadKind(kind: SampleFrameKind): Promise<HTMLCanvasElement> {
  const cached = canvases.get(kind);
  if (cached) {
    canvases.delete(kind);
    canvases.set(kind, cached);
    return Promise.resolve(cached);
  }
  const pending = loaders.get(kind);
  if (pending) return pending;
  const generation = generations[kind];
  const load = new Promise<HTMLCanvasElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE_W;
      canvas.height = SAMPLE_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('2d context unavailable for sample frame'));
        return;
      }
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);
      drawCover(ctx, img);
      if (generations[kind] === generation) rememberCanvas(kind, canvas);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error(`failed to load ${SRC[kind]}`));
    img.src = SRC[kind];
  });
  let settled: Promise<HTMLCanvasElement>;
  settled = load.finally(() => {
    if (loaders.get(kind) === settled) loaders.delete(kind);
  });
  loaders.set(kind, settled);
  return settled;
}

/** Kick off bounded sample-frame loads for preview consumers. */
export function preloadSampleFrames(): Promise<void> {
  return Promise.all((Object.keys(SRC) as SampleFrameKind[]).map(loadKind)).then(() => undefined);
}

/** sync access after load; null if not ready yet */
export function getSampleFrame(kind: SampleFrameKind): HTMLCanvasElement | null {
  const canvas = canvases.get(kind);
  if (!canvas) return null;
  canvases.delete(kind);
  canvases.set(kind, canvas);
  return canvas;
}

/** ensure ready then return */
export async function ensureSampleFrame(kind: SampleFrameKind): Promise<HTMLCanvasElement> {
  return loadKind(kind);
}

/** Release decoded preview frames when their resource tab is left. */
export function clearSampleFrames(kinds: readonly SampleFrameKind[]): void {
  for (const kind of kinds) {
    generations[kind]++;
    loaders.delete(kind);
    const canvas = canvases.get(kind);
    canvases.delete(kind);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
