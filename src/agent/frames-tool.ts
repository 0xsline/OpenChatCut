import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { MediaAsset, TimelineItem, TimelineState, TrackId } from '../editor/types';
import { defaultTrackId, timelineDuration } from '../editor/types';

// view_timeline_frames + view_asset_frames (source 护城河/域B 工具): render still
// frames in headless Chrome (/render-still, same bundle as export) and hand them
// to the model as images. view_timeline_frames = the CURRENT (draft!) timeline —
// the agent SEES its own pending edits. view_asset_frames = a single media-pool
// SOURCE asset in isolation — the agent inspects footage/MG content before
// placing it (B-roll / multi-clip selection, source skills reference this).

type Args = Record<string, unknown>;

const MAX_FRAMES = 8;

export const FRAMES_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'view_timeline_frames',
    description:
      'Render still frames of the timeline and SEE them as images (your pending edits included). Use after visual edits (adding MG/text, transitions, zoom, filters, aspect changes) to verify the result looks right before finishing. Provide exact frames OR seconds; with neither, 3 frames are sampled evenly. Max 8 per call.',
    input_schema: {
      type: 'object',
      properties: {
        frames: { type: 'array', items: { type: 'number' }, description: 'Exact frame numbers to render.' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds to render (converted by fps).' },
        count: { type: 'number', description: 'No frames/seconds given: sample this many evenly across the timeline (default 3).' },
      },
    },
  },
  {
    name: 'view_asset_frames',
    description:
      'Render still frames of a single media-pool ASSET on its own (video / image / motion-graphic) and SEE them as images. Use to inspect what footage or an MG actually looks like before placing it on the timeline (e.g. picking B-roll, choosing among clips). Give assetId (prefix ok) + optional frames/seconds; with neither, 3 frames are sampled evenly across the asset. Audio assets have no frames. Max 8 per call.',
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Media-pool asset id (prefix ok).' },
        frames: { type: 'array', items: { type: 'number' }, description: 'Exact frame numbers within the asset.' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds within the asset (converted by fps).' },
        count: { type: 'number', description: 'No frames/seconds given: sample this many evenly across the asset (default 3).' },
      },
      required: ['assetId'],
    },
  },
];

export const FRAMES_TOOL_NAMES = new Set(FRAMES_TOOL_SCHEMAS.map((t) => t.name));

/** Resolve which frames to render: explicit frames → seconds → N even midpoints. */
function pickFrames(args: Args, total: number, fps: number): number[] {
  let frames: number[];
  if (Array.isArray(args.frames) && args.frames.length) {
    frames = args.frames.map(Number);
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    frames = args.seconds.map((s) => Math.round(Number(s) * fps));
  } else {
    const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || 3)));
    // midpoints of n even slices (avoids the black first/last frame)
    frames = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * total));
  }
  return [...new Set(frames.map((f) => Math.max(0, Math.min(total - 1, Math.round(f)))))].slice(0, MAX_FRAMES);
}

/** POST a TimelineState + frame list to /render-still; return the model-facing image payload. */
async function renderStills(state: TimelineState, frames: number[], note: (rendered: number[]) => string): Promise<unknown> {
  try {
    const res = await fetch('/render-still', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames }),
    });
    if (!res.ok) {
      const info = (await res.json().catch(() => null)) as { error?: string } | null;
      return { error: info?.error ?? `render-still failed (${res.status})` };
    }
    const data = (await res.json()) as { frames: { frame: number; base64: string }[] };
    return { __images: data.frames, note: note(data.frames.map((f) => f.frame)) };
  } catch (e) {
    return { error: `render-still 请求失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Build a one-item timeline that renders `asset` alone at frame 0 on the project canvas
 * (or the asset's own size when known), so /render-still shows just that asset. */
function assetPreviewState(base: TimelineState, asset: MediaAsset, track: TrackId): TimelineState {
  const common = { id: `preview_${asset.id}`, track, startFrame: 0, durationInFrames: Math.max(1, asset.durationInFrames), name: asset.name };
  let item: TimelineItem;
  if (asset.kind === 'motion-graphic') {
    item = { ...common, kind: 'motion-graphic', templateId: asset.id, code: asset.code, props: asset.props ?? {}, width: asset.width, height: asset.height };
  } else if (asset.kind === 'image') {
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
  const state = ctx.getState();
  const total = timelineDuration(state);
  const frames = pickFrames(args, total, state.fps);
  return renderStills(state, frames, (r) =>
    `渲染了 ${r.length} 帧（帧号 ${r.join(', ')}，共 ${total} 帧 @${state.fps}fps）——以上即当前时间线（含你未提交的编辑）的实际画面。`);
}

async function viewAssetFrames(args: Args, ctx: AgentContext): Promise<unknown> {
  const q = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  if (!q) return { error: 'view_asset_frames requires assetId' };
  const asset = ctx.getDoc().assets.find((a) => a.id === q || a.id.startsWith(q));
  if (!asset) return { error: `no asset ${q}` };
  if (asset.kind === 'audio') return { error: `asset "${asset.name}" is audio — it has no frames to render` };

  const base = ctx.getState();
  const track = defaultTrackId(base, 'video');
  if (!track) return { error: 'no video track to render the asset preview on' };
  const total = Math.max(1, asset.durationInFrames);
  const frames = pickFrames(args, total, base.fps);
  const state = assetPreviewState(base, asset, track);
  return renderStills(state, frames, (r) =>
    `渲染了资产「${asset.name}」的 ${r.length} 帧（帧号 ${r.join(', ')}，共 ${total} 帧）——以上即该源资产单独的画面，尚未放到时间线上。`);
}

export async function execFramesTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'view_timeline_frames') return viewTimelineFrames(args, ctx);
  if (name === 'view_asset_frames') return viewAssetFrames(args, ctx);
  return { error: `unknown tool ${name}` };
}
