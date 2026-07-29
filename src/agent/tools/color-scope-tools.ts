// inspect_color - Numerical color grading oscilloscope: measure the black and white points/overflow/color shift/saturation/hue histogram of a frame,
// Let Agent adjust color by numbers rather than by visual inspection based on screenshots. Pixel statistics are in src/color/scopes.ts (pure function);
// Here we only do frame fetching (multiplexing /render-still and /api/extract-frames) and decoding glue.
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { analyzeRgbaPixels, describeScopeStats, type ColorScopeStats } from '../../color/scopes';

type Args = Record<string, unknown>;

/** Press the long side to this size before counting: it is enough for full frame statistics and saves an order of magnitude in decoding/traversal. */
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
      'To match another shot in one call, pass referenceFrame/referenceSeconds or referenceAssetId/referenceSourceSeconds.',
      'The result includes signed target-minus-reference deltas and dead-zone-filtered named control suggestions.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        frame: { type: 'number', description: 'Timeline frame to measure (composited). Default: middle of the content.' },
        seconds: { type: 'number', description: 'Timeline time in seconds (alternative to frame).' },
        assetId: { type: 'string', description: 'Measure a RAW media-pool asset instead of the timeline (prefix id ok).' },
        sourceSeconds: { type: 'number', description: 'Asset mode only: source time to sample (default: asset midpoint).' },
        referenceFrame: { type: 'number', description: 'Reference timeline frame to compare against.' },
        referenceSeconds: { type: 'number', description: 'Reference timeline time in seconds (alternative to referenceFrame).' },
        referenceAssetId: { type: 'string', description: 'Compare against a RAW media-pool asset frame (prefix id ok).' },
        referenceSourceSeconds: { type: 'number', description: 'Reference asset source time (default: midpoint).' },
      },
    },
  },
];

export const COLOR_SCOPE_TOOL_NAMES = new Set(COLOR_SCOPE_TOOL_SCHEMAS.map((t) => t.name));

/** base64 PNG/JPEG → downsample RGBA pixels (browser-specific: createImageBitmap + canvas). */
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
  else body.count = 1; // The server automatically takes the midpoint
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

type ScopeResult = Record<string, unknown> & { rawStats: ColorScopeStats };

const delta = (target: number, reference: number): number => round3(target - reference);

function suggestion(control: string, direction: string, value: number, reason: string) {
  return { control, direction, targetMinusReference: round3(value), reason };
}

export function compareColorScopes(target: ColorScopeStats, reference: ColorScopeStats) {
  const meanLuma = target.meanLuma - reference.meanLuma;
  const contrast = (target.whitePoint - target.blackPoint) - (reference.whitePoint - reference.blackPoint);
  const saturation = target.saturationMean - reference.saturationMean;
  const warmCool = target.warmCool - reference.warmCool;
  const greenMagenta = target.greenMagenta - reference.greenMagenta;
  const suggestions = [
    ...(Math.abs(meanLuma) >= 0.03 ? [suggestion('brightness', meanLuma > 0 ? 'decrease' : 'increase', meanLuma, 'match mean luma')] : []),
    ...(Math.abs(contrast) >= 0.05 ? [suggestion('contrast', contrast > 0 ? 'decrease' : 'increase', contrast, 'match black-to-white span')] : []),
    ...(Math.abs(saturation) >= 0.04 ? [suggestion('saturate', saturation > 0 ? 'decrease' : 'increase', saturation, 'match mean saturation')] : []),
    ...(Math.abs(warmCool) >= 0.025 ? [suggestion('temperature', warmCool > 0 ? 'cooler' : 'warmer', warmCool, 'match R-B balance')] : []),
    ...(Math.abs(greenMagenta) >= 0.02 ? [suggestion('tint', greenMagenta > 0 ? 'toward magenta' : 'toward green', greenMagenta, 'match green-magenta balance')] : []),
    ...(target.clippedHighlightsPct - reference.clippedHighlightsPct >= 0.01
      ? [suggestion('highlights', 'decrease', target.clippedHighlightsPct - reference.clippedHighlightsPct, 'reduce extra highlight clipping')] : []),
    ...(target.clippedShadowsPct - reference.clippedShadowsPct >= 0.01
      ? [suggestion('shadows', 'lift', target.clippedShadowsPct - reference.clippedShadowsPct, 'reduce extra shadow clipping')] : []),
  ];
  return {
    targetMinusReference: {
      blackPoint: delta(target.blackPoint, reference.blackPoint),
      whitePoint: delta(target.whitePoint, reference.whitePoint),
      meanLuma: delta(target.meanLuma, reference.meanLuma),
      clippedShadowsPct: delta(target.clippedShadowsPct, reference.clippedShadowsPct),
      clippedHighlightsPct: delta(target.clippedHighlightsPct, reference.clippedHighlightsPct),
      channelMeans: {
        r: delta(target.channelMeans.r, reference.channelMeans.r),
        g: delta(target.channelMeans.g, reference.channelMeans.g),
        b: delta(target.channelMeans.b, reference.channelMeans.b),
      },
      warmCool: delta(target.warmCool, reference.warmCool),
      greenMagenta: delta(target.greenMagenta, reference.greenMagenta),
      saturationMean: delta(target.saturationMean, reference.saturationMean),
      tilt: Object.fromEntries((['shadows', 'mids', 'highlights'] as const).map((band) => [band, {
        warmCool: delta(target.tilt[band].warmCool, reference.tilt[band].warmCool),
        greenMagenta: delta(target.tilt[band].greenMagenta, reference.tilt[band].greenMagenta),
      }])),
      hueHistogram: target.hueHistogram.map((bin, index) => ({
        label: bin.label,
        pct: delta(bin.pct, reference.hueHistogram[index]?.pct ?? 0),
      })),
    },
    suggestions,
  };
}

async function measureAsset(ctx: AgentContext, rawId: unknown, rawSeconds: unknown): Promise<ScopeResult> {
  const q = typeof rawId === 'string' ? rawId.trim() : '';
  const asset = ctx.getDoc().assets.find((item) => item.id === q || item.id.startsWith(q));
  if (!asset) throw new Error(`no media-pool asset ${q}`);
  if (!asset.src.startsWith('/media/uploads/')) {
    throw new Error(`asset ${asset.id} is not an uploaded media file — inspect the timeline instead`);
  }
  const sourceMs = typeof rawSeconds === 'number'
    ? rawSeconds * 1000
    : asset.kind === 'image' ? 0 : undefined;
  const { data } = await decodeBase64Pixels(await assetFrameBase64(asset.src, sourceMs));
  const rawStats = analyzeRgbaPixels(data);
  return {
    mode: 'asset', assetId: asset.id,
    sourceSeconds: sourceMs === undefined ? 'midpoint' : round3(sourceMs / 1000),
    reading: describeScopeStats(rawStats), stats: compactStats(rawStats), rawStats,
  };
}

async function measureTimeline(ctx: AgentContext, rawFrame: unknown, rawSeconds: unknown): Promise<ScopeResult> {
  const state = ctx.getState();
  const contentEnd = state.items.reduce((max, item) => Math.max(max, item.startFrame + item.durationInFrames), 0);
  if (contentEnd === 0) throw new Error('timeline is empty — nothing to measure');
  const frame = typeof rawFrame === 'number' ? Math.max(0, Math.round(rawFrame))
    : typeof rawSeconds === 'number' ? Math.max(0, Math.round(rawSeconds * state.fps))
      : Math.floor(contentEnd / 2);
  const { data } = await decodeBase64Pixels(await timelineFrameBase64(ctx, frame));
  const rawStats = analyzeRgbaPixels(data);
  return {
    mode: 'timeline', frame, seconds: round3(frame / state.fps),
    reading: describeScopeStats(rawStats), stats: compactStats(rawStats), rawStats,
  };
}

function publicResult(result: ScopeResult): Record<string, unknown> {
  const { rawStats: _rawStats, ...visible } = result;
  return visible;
}

export async function execColorScopeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'inspect_color') return { error: `unknown tool ${name}` };
  try {
    const target = typeof args.assetId === 'string' && args.assetId.trim()
      ? await measureAsset(ctx, args.assetId, args.sourceSeconds)
      : await measureTimeline(ctx, args.frame, args.seconds);
    const hasReference = ['referenceAssetId', 'referenceFrame', 'referenceSeconds']
      .some((key) => args[key] !== undefined);
    if (!hasReference) return publicResult(target);
    const reference = typeof args.referenceAssetId === 'string' && args.referenceAssetId.trim()
      ? await measureAsset(ctx, args.referenceAssetId, args.referenceSourceSeconds)
      : await measureTimeline(ctx, args.referenceFrame, args.referenceSeconds);
    return {
      mode: 'comparison',
      target: publicResult(target),
      reference: publicResult(reference),
      ...compareColorScopes(target.rawStats, reference.rawStats),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
