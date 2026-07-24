import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { MediaAsset, Timeline, TimelineItem, TimelineState, TrackId } from '../../editor/types';
import { defaultTrackId, timelineDuration } from '../../editor/types';
import { extractBlobContactSheet, extractBlobImagePreview, isBlobishSrc } from './blob-frames';
import { resolveTimeline } from './timeline-target';

// view_timeline_frames + view_asset_frames provide visual inspection tools.
//
// - view_asset_frames: media contact sheet (sourceTimesMs midpoints, 12–20 samples)
// - view_timeline_frames: COMPOSED timeline stills (draft edits included)
// Both return labeled JPEG evidence the model can SEE (multimodal tool_result).
//
// Local paths:
// - Asset videos under /media/uploads → fast ffmpeg /api/extract-frames (contact sheet)
// - Timeline / MG / images → Remotion /render-still (reused Chrome) + optional grid tile

type Args = Record<string, unknown>;

const MAX_FRAMES = 16;
/** Default sample count for a broad media scan. */
const DEFAULT_ASSET_SCAN = 12;
const DEFAULT_TIMELINE_SCAN = 4;

export const FRAMES_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'view_timeline_frames',
    description: [
      'Render still frames of the CURRENT timeline composition and SEE them as images (pending/draft edits included).',
      'Use after visual edits (MG/text, transitions, zoom, filters, aspect, captions) to verify the result before finishing.',
      'Provide exact frames, seconds, or count; with neither, samples evenly (default 4, max 16).',
      'Multi-frame results come back as ONE labeled contact-sheet JPEG when possible.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        frames: { type: 'array', items: { type: 'number' }, description: 'Exact frame numbers to render.' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds (converted by timeline fps).' },
        count: { type: 'number', description: 'Even midpoints across the full timeline (default 4, max 16).' },
        fromSeconds: { type: 'number', description: 'Optional range start (with toSeconds) for focused sampling.' },
        toSeconds: { type: 'number', description: 'Optional range end (exclusive-ish; with fromSeconds).' },
        timelineId: { type: 'string', description: 'Override the active timeline by id or prefix without switching timelines.' },
      },
    },
  },
  {
    name: 'view_asset_frames',
    description: [
      'Inspect a SOURCE media-pool asset (not the timeline) and SEE a labeled contact sheet.',
      'Use for B-roll selection, finding a logo/moment, judging shot quality, long-clip high-light scanning.',
      'Prefer sourceTimesMs for precise ms samples; or count/fromSeconds/toSeconds for a broad scan',
      '(default 12 midpoints, max 16). Video files on /media/uploads use fast ffmpeg; MG/images use Remotion.',
      'NOT for timeline proof — use view_timeline_frames after edits. Audio has no frames.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Media-pool asset id (prefix ok).' },
        sourceTimesMs: {
          type: 'array',
          items: { type: 'number' },
          description: 'Millisecond offsets into the source video. Accepts 1–16 values.',
        },
        frames: { type: 'array', items: { type: 'number' }, description: 'Frame numbers within the asset (fps-based).' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds within the asset.' },
        count: { type: 'number', description: 'Even midpoints across range (default 12 for video scan, max 16).' },
        fromSeconds: { type: 'number', description: 'Range start for scanning a sub-span of a long clip.' },
        toSeconds: { type: 'number', description: 'Range end for scanning a sub-span.' },
      },
      required: ['assetId'],
    },
  },
];

export const FRAMES_TOOL_NAMES = new Set(FRAMES_TOOL_SCHEMAS.map((t) => t.name));

/** Midpoints of n equal blocks in [0, total). */
function evenMidpoints(total: number, count: number): number[] {
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));
  const t = Math.max(1, total);
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * t));
}

/** Resolve which frames to render: sourceTimesMs → frames → seconds → range midpoints → full midpoints. */
function pickFrames(
  args: Args,
  total: number,
  fps: number,
  defaultCount: number,
): number[] {
  let frames: number[];
  if (Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length) {
    frames = args.sourceTimesMs.map((ms) => Math.round((Number(ms) / 1000) * fps));
  } else if (Array.isArray(args.frames) && args.frames.length) {
    frames = args.frames.map(Number);
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    frames = args.seconds.map((s) => Math.round(Number(s) * fps));
  } else {
    const fromS = typeof args.fromSeconds === 'number' ? args.fromSeconds : null;
    const toS = typeof args.toSeconds === 'number' ? args.toSeconds : null;
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || defaultCount)));
    if (fromS != null && toS != null && toS > fromS) {
      const fromF = Math.max(0, Math.round(fromS * fps));
      const toF = Math.min(total, Math.round(toS * fps));
      const span = Math.max(1, toF - fromF);
      frames = evenMidpoints(span, count).map((f) => fromF + f);
    } else {
      frames = evenMidpoints(total, count);
    }
  }
  return [...new Set(
    frames.map((f) => Math.max(0, Math.min(Math.max(0, total - 1), Math.round(f)))),
  )].slice(0, MAX_FRAMES);
}

type ImagePayload = {
  __images: { frame: number; base64: string }[];
  frames: number[];
  layout: 'contact_sheet' | 'individual';
  note: string;
  renderedBy?: string;
  sampleCount?: number;
  sourceTimesMs?: number[];
};

/** Prefer a single contact-sheet image for multi-frame vision. */
function packImages(
  frames: { frame: number; base64: string }[],
  gridBase64: string | undefined,
  note: string,
  extra?: Partial<ImagePayload>,
): ImagePayload {
  if (gridBase64 && frames.length >= 2) {
    const map = frames.map((f, i) => `[${i + 1}]f${f.frame}`).join(' ');
    return {
      __images: [{ frame: frames[0]!.frame, base64: gridBase64 }],
      frames: frames.map((frame) => frame.frame),
      layout: 'contact_sheet',
      note: `${note} · contact sheet ${frames.length} cells L→R T→B: ${map}`,
      ...extra,
    };
  }
  return {
    __images: frames,
    frames: frames.map((frame) => frame.frame),
    layout: 'individual',
    note,
    ...extra,
  };
}

async function renderStills(
  state: TimelineState,
  frames: number[],
  note: string,
): Promise<ImagePayload | { error: string }> {
  try {
    const res = await fetch('/render-still', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames, grid: true, fps: state.fps }),
    });
    if (!res.ok) {
      const info = (await res.json().catch(() => null)) as { error?: string } | null;
      return { error: info?.error ?? `render-still failed (${res.status})` };
    }
    const data = (await res.json()) as {
      frames: { frame: number; base64: string }[];
      gridBase64?: string;
      renderedBy?: string;
    };
    return packImages(data.frames, data.gridBase64, note, { renderedBy: data.renderedBy ?? 'remotion' });
  } catch (e) {
    return { error: `render-still Request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Fast path: ffmpeg contact sheet for uploaded video masters. */
async function extractAssetContactSheet(
  src: string,
  args: Args,
  asset: MediaAsset,
  fps: number,
): Promise<ImagePayload | { error: string } | null> {
  if (!src.startsWith('/media/uploads/')) return null;
  if (asset.kind !== 'video' && asset.kind !== 'gif') return null;

  const body: Record<string, unknown> = { src };
  if (Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length) {
    body.sourceTimesMs = args.sourceTimesMs.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    body.sourceTimesMs = args.seconds.map((s) => Math.round(Number(s) * 1000));
  } else if (Array.isArray(args.frames) && args.frames.length) {
    body.sourceTimesMs = args.frames.map((f) => Math.round((Number(f) / fps) * 1000));
  } else {
    body.count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || DEFAULT_ASSET_SCAN)));
    if (typeof args.fromSeconds === 'number') body.fromMs = Math.round(args.fromSeconds * 1000);
    if (typeof args.toSeconds === 'number') body.toMs = Math.round(args.toSeconds * 1000);
  }

  try {
    const res = await fetch('/api/extract-frames', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Fall through to Remotion path
      return null;
    }
    const data = (await res.json()) as {
      base64?: string;
      sampleCount?: number;
      sourceTimesMs?: number[];
      labels?: string[];
      renderedBy?: string;
      note?: string;
    };
    if (!data.base64) return null;
    const labels = data.labels ?? [];
    const labelLine = labels.length
      ? `cells L→R T→B: ${labels.map((l, i) => `[${i + 1}]${l}`).join(' ')}`
      : '';
    const sourceTimesMs = data.sourceTimesMs ?? [];
    return {
      __images: [{ frame: 0, base64: data.base64 }],
      frames: sourceTimesMs.length ? sourceTimesMs.map((ms) => Math.round((ms / 1000) * fps)) : [0],
      layout: (data.sampleCount ?? 1) > 1 ? 'contact_sheet' : 'individual',
      note: [
        `source assets${asset.name}」contact sheet`,
        data.sampleCount ? `${data.sampleCount} samples` : '',
        labelLine,
        '(Not entered into the timeline synthesis; each frame≈Corresponding to the midpoint of the source time interval)',
      ].filter(Boolean).join(' · '),
      renderedBy: data.renderedBy ?? 'ffmpeg',
      sampleCount: data.sampleCount,
      sourceTimesMs,
    };
  } catch {
    return null;
  }
}

/** Build a one-item timeline that renders `asset` alone. */
function assetPreviewState(base: TimelineState, asset: MediaAsset, track: TrackId): TimelineState {
  const common = {
    id: `preview_${asset.id}`,
    track,
    startFrame: 0,
    durationInFrames: Math.max(1, asset.durationInFrames),
    name: asset.name,
  };
  let item: TimelineItem;
  if (asset.kind === 'motion-graphic') {
    item = {
      ...common,
      kind: 'motion-graphic',
      templateId: asset.id,
      code: asset.code,
      props: asset.props ?? {},
      width: asset.width,
      height: asset.height,
    };
  } else if (asset.kind === 'image' || asset.kind === 'svg') {
    item = { ...common, kind: 'image', src: asset.src, width: asset.width, height: asset.height };
  } else {
    item = { ...common, kind: 'video', src: asset.src, width: asset.width, height: asset.height };
  }
  return {
    ...base,
    width: asset.width ?? base.width,
    height: asset.height ?? base.height,
    items: [item],
    transitions: [],
    markers: [],
    selectedId: null,
  };
}

async function viewTimelineFrames(args: Args, ctx: AgentContext): Promise<unknown> {
  let state: Timeline;
  try {
    state = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const total = Math.max(1, timelineDuration(state));
  if (total <= 0 || !state.items.length) {
    return { error: 'timeline is empty — nothing to render' };
  }
  const frames = pickFrames(args, total, state.fps, DEFAULT_TIMELINE_SCAN);
  const note = `Timeline "${state.name}」${frames.length} frame(f${frames.join(', f')}, a total of ${total} @${state.fps}fps)——Target timeline draft synthesis screen (including unsubmitted edits)`;
  return renderStills(state, frames, note);
}

async function viewAssetFrames(args: Args, ctx: AgentContext): Promise<unknown> {
  const q = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  if (!q) return { error: 'view_asset_frames requires assetId' };
  const asset = ctx.getDoc().assets.find((a) => a.id === q || a.id.startsWith(q));
  if (!asset) return { error: `no asset ${q}` };
  if (asset.kind === 'audio') {
    return { error: `asset "${asset.name}" is audio — it has no frames to render` };
  }

  const base = ctx.getState();
  const fps = base.fps || 30;

  // Upload-in-progress placeholder: sample from blob: in the browser (no server path yet).
  if (isBlobishSrc(asset.src)) {
    if (asset.kind === 'image' || asset.kind === 'svg') {
      const b64 = await extractBlobImagePreview(asset.src);
      if (b64) {
        return {
          __images: [{ frame: 0, base64: b64 }],
          frames: [0],
          layout: 'individual',
          note: `source assets${asset.name}」blob Preview (uploading/local placeholder)`,
          renderedBy: 'browser-blob',
        };
      }
    }
    if (asset.kind === 'video' || asset.kind === 'gif') {
      const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || DEFAULT_ASSET_SCAN)));
      const sheet = await extractBlobContactSheet(asset.src, {
        sourceTimesMs: Array.isArray(args.sourceTimesMs)
          ? args.sourceTimesMs.map(Number).filter((n) => Number.isFinite(n))
          : Array.isArray(args.seconds)
            ? args.seconds.map((s) => Math.round(Number(s) * 1000))
            : undefined,
        count,
        fromMs: typeof args.fromSeconds === 'number' ? Math.round(args.fromSeconds * 1000) : undefined,
        toMs: typeof args.toSeconds === 'number' ? Math.round(args.toSeconds * 1000) : undefined,
      });
      if (sheet) {
        const labelLine = sheet.labels.map((l, i) => `[${i + 1}]${l}`).join(' ');
        return {
          __images: [{ frame: 0, base64: sheet.base64 }],
          frames: sheet.sourceTimesMs.map((ms) => Math.round((ms / 1000) * fps)),
          layout: sheet.sampleCount > 1 ? 'contact_sheet' : 'individual',
          note: `source assets${asset.name}」blob contact sheet · ${sheet.sampleCount} samples · cells L→R T→B: ${labelLine}(Local preview during upload)`,
          renderedBy: 'browser-blob',
          sampleCount: sheet.sampleCount,
          sourceTimesMs: sheet.sourceTimesMs,
        };
      }
    }
  }

  // Prefer fast ffmpeg contact sheet for uploaded video/gif masters.
  if (asset.src) {
    const sheet = await extractAssetContactSheet(asset.src, args, asset, fps);
    if (sheet && !('error' in sheet)) return sheet;
  }

  const track = defaultTrackId(base, 'video');
  if (!track) return { error: 'no video track to render the asset preview on' };
  const total = Math.max(1, asset.durationInFrames);
  const frames = pickFrames(args, total, fps, asset.kind === 'video' || asset.kind === 'gif' ? DEFAULT_ASSET_SCAN : 1);
  const state = assetPreviewState(base, asset, track);
  const note = `source assets${asset.name}」${frames.length} frame(f${frames.join(', f')}, a total of ${total})——Preview alone, not combined into the timeline`;
  return renderStills(state, frames, note);
}

export async function execFramesTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'view_timeline_frames') return viewTimelineFrames(args, ctx);
  if (name === 'view_asset_frames') return viewAssetFrames(args, ctx);
  return { error: `unknown tool ${name}` };
}
