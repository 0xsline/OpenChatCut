// Shared photoreal sample frames for library-card previews (FX / LUT / zoom /
// transitions). Loaded once from /library-previews/*.jpg then drawn into fixed
// offscreen canvases so WebGL texImage2D always gets a ready TexImageSource.

export const SAMPLE_W = 320;
export const SAMPLE_H = 180;

const SRC = {
  fx: '/library-previews/sample-fx.jpg?v=tokyo-tower-1', // Tokyo Tower — FX / LUT / zoom
  out: '/library-previews/sample-out.jpg', // outdoor street — transition A
  in: '/library-previews/sample-in.jpg',   // warm interior — transition B
} as const;

type Kind = keyof typeof SRC;

const canvases: Partial<Record<Kind, HTMLCanvasElement>> = {};
const loaders: Partial<Record<Kind, Promise<HTMLCanvasElement>>> = {};

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const scale = Math.max(SAMPLE_W / iw, SAMPLE_H / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, (SAMPLE_W - dw) / 2, (SAMPLE_H - dh) / 2, dw, dh);
}

function loadKind(kind: Kind): Promise<HTMLCanvasElement> {
  if (canvases[kind]) return Promise.resolve(canvases[kind]!);
  if (loaders[kind]) return loaders[kind]!;
  loaders[kind] = new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = SAMPLE_W;
      c.height = SAMPLE_H;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);
      drawCover(ctx, img);
      canvases[kind] = c;
      resolve(c);
    };
    img.onerror = () => reject(new Error(`failed to load ${SRC[kind]}`));
    img.src = SRC[kind];
  });
  return loaders[kind]!;
}

/** kick off all sample loads (call once from library mount) */
export function preloadSampleFrames(): Promise<void> {
  return Promise.all((Object.keys(SRC) as Kind[]).map((k) => loadKind(k))).then(() => undefined);
}

/** sync access after load; null if not ready yet */
export function getSampleFrame(kind: Kind): HTMLCanvasElement | null {
  return canvases[kind] ?? null;
}

/** ensure ready then return */
export async function ensureSampleFrame(kind: Kind): Promise<HTMLCanvasElement> {
  return loadKind(kind);
}
