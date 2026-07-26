// inspect_color —— 数值化调色示波:量一帧画面的黑白点/溢出/色偏/饱和度/色相直方图,
// 让 Agent 按数字调色而不是凭截图目测。像素统计在 src/color/scopes.ts(纯函数);
// 这里只做取帧(复用 /render-still 与 /api/extract-frames)与解码胶水。
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { analyzeRgbaPixels, describeScopeStats, type ColorScopeStats } from '../../color/scopes';

type Args = Record<string, unknown>;

/** 统计前把长边压到这个尺寸:对全帧统计足够,解码/遍历都省一个量级。 */
const ANALYZE_MAX_EDGE = 320;

export const COLOR_SCOPE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'inspect_color',
    description: [
      'Measure color scopes of a frame BY THE NUMBERS instead of eyeballing screenshots: luma black/white points, % clipped',
      'shadows/highlights, per-channel means, warm-cool (R−B) and green-magenta balance overall AND per luma band',
      '(shadows/mids/highlights), mean saturation, and a saturation-weighted 12-bin hue histogram (30° bins from red) with',
      'dominant-hue labels — e.g. an orange cluster is usually skin, cyan/azure is usually sky.',
      'Default mode measures the COMPOSITED timeline at `frame` or `seconds` (grades/filters/effects applied, all layers',
      'stacked — to read one clip, pick a frame where it fills the screen). Pass assetId (+ sourceSeconds) to measure a RAW',
      'media-pool asset frame before any grading instead.',
      'Typical loop: inspect_color → adjust via edit_item filters / color effects / LUT looks → inspect_color again to',
      'confirm the numbers moved as intended. Use view_timeline_frames when you also want to SEE the frame.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        frame: { type: 'number', description: 'Timeline frame to measure (composited). Default: middle of the content.' },
        seconds: { type: 'number', description: 'Timeline time in seconds (alternative to frame).' },
        assetId: { type: 'string', description: 'Measure a RAW media-pool asset instead of the timeline (prefix id ok).' },
        sourceSeconds: { type: 'number', description: 'Asset mode only: source time to sample (default: asset midpoint).' },
      },
    },
  },
];

export const COLOR_SCOPE_TOOL_NAMES = new Set(COLOR_SCOPE_TOOL_SCHEMAS.map((t) => t.name));

/** base64 PNG/JPEG → 降采样 RGBA 像素(浏览器专用:createImageBitmap + canvas)。 */
async function decodeBase64Pixels(base64: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, ANALYZE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { data: context.getImageData(0, 0, width, height).data, width, height };
}

async function timelineFrameBase64(ctx: AgentContext, frame: number): Promise<string> {
  const state = ctx.getState();
  const res = await fetch('/render-still', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, frames: [frame], fps: state.fps }),
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? `render-still failed (${res.status})`);
  }
  const data = (await res.json()) as { frames: { frame: number; base64: string }[] };
  const base64 = data.frames?.[0]?.base64;
  if (!base64) throw new Error('render-still returned no frame');
  return base64;
}

async function assetFrameBase64(src: string, sourceMs: number | undefined): Promise<string> {
  const body: Record<string, unknown> = { src };
  if (sourceMs !== undefined) body.sourceTimesMs = [Math.max(0, Math.round(sourceMs))];
  else body.count = 1; // 服务端自动取中点
  const res = await fetch('/api/extract-frames', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(info?.error ?? `extract-frames failed (${res.status})`);
  }
  const data = (await res.json()) as { base64?: string };
  if (!data.base64) throw new Error('extract-frames returned no image');
  return data.base64;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function compactStats(s: ColorScopeStats): Record<string, unknown> {
  return {
    blackPoint: round3(s.blackPoint),
    whitePoint: round3(s.whitePoint),
    meanLuma: round3(s.meanLuma),
    clippedShadowsPct: round3(s.clippedShadowsPct),
    clippedHighlightsPct: round3(s.clippedHighlightsPct),
    channelMeans: { r: round3(s.channelMeans.r), g: round3(s.channelMeans.g), b: round3(s.channelMeans.b) },
    warmCool: round3(s.warmCool),
    greenMagenta: round3(s.greenMagenta),
    saturationMean: round3(s.saturationMean),
    tilt: {
      shadows: { warmCool: round3(s.tilt.shadows.warmCool), greenMagenta: round3(s.tilt.shadows.greenMagenta) },
      mids: { warmCool: round3(s.tilt.mids.warmCool), greenMagenta: round3(s.tilt.mids.greenMagenta) },
      highlights: { warmCool: round3(s.tilt.highlights.warmCool), greenMagenta: round3(s.tilt.highlights.greenMagenta) },
    },
    hueHistogram: s.hueHistogram.filter((bin) => bin.pct >= 0.01)
      .map((bin) => ({ label: bin.label, fromDeg: bin.fromDeg, pct: round3(bin.pct) })),
    dominantHues: s.dominantHues,
  };
}

export async function execColorScopeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'inspect_color') return { error: `unknown tool ${name}` };
  try {
    if (typeof args.assetId === 'string' && args.assetId.trim()) {
      const q = args.assetId.trim();
      const asset = ctx.getDoc().assets.find((a) => a.id === q || a.id.startsWith(q));
      if (!asset) return { error: `no media-pool asset ${q}` };
      if (!asset.src.startsWith('/media/uploads/')) {
        return { error: `asset ${asset.id} is not an uploaded media file — inspect the timeline instead` };
      }
      const sourceMs = typeof args.sourceSeconds === 'number' ? args.sourceSeconds * 1000 : undefined;
      const { data } = await decodeBase64Pixels(await assetFrameBase64(asset.src, sourceMs));
      const stats = analyzeRgbaPixels(data);
      return {
        mode: 'asset',
        assetId: asset.id,
        ...(sourceMs !== undefined ? { sourceSeconds: round3(sourceMs / 1000) } : { sourceSeconds: 'midpoint' }),
        reading: describeScopeStats(stats),
        stats: compactStats(stats),
      };
    }

    const state = ctx.getState();
    const contentEnd = state.items.reduce((max, it) => Math.max(max, it.startFrame + it.durationInFrames), 0);
    const frame = typeof args.frame === 'number' ? Math.max(0, Math.round(args.frame))
      : typeof args.seconds === 'number' ? Math.max(0, Math.round(args.seconds * state.fps))
        : Math.floor(contentEnd / 2);
    if (contentEnd === 0) return { error: 'timeline is empty — nothing to measure' };
    const { data } = await decodeBase64Pixels(await timelineFrameBase64(ctx, frame));
    const stats = analyzeRgbaPixels(data);
    return {
      mode: 'timeline',
      frame,
      seconds: round3(frame / state.fps),
      reading: describeScopeStats(stats),
      stats: compactStats(stats),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
