export { FRAMES_TOOL_SCHEMAS, FRAMES_TOOL_NAMES } from './schemas/frames-tool';
import type { AgentContext } from '../context';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem, TimelineState, TrackId } from '../../editor/types';
import { defaultTrackId } from '../../editor/types';
import { resolveTimelineRenderPlan } from '../../editor/sequenceGraph';
import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import type { SourceFrameWindow } from '../../editor/sourceLimit';
import { extractBlobContactSheet, extractBlobImagePreview, isBlobishSrc } from './blob-frames';
import { resolveTimeline } from './timeline-target';
import { maybeDescribeFramesResult } from '../vision';

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
/** Clamp source-coordinate arguments to a half-open visible source window. */
export function constrainSourceFrameArgs(
  args: Args,
  window: SourceFrameWindow,
  fps: number,
): Args {
  const firstFrame = Math.max(0, Math.ceil(window.startFrame));
  const lastFrame = Math.max(firstFrame, Math.ceil(window.endFrame) - 1);
  const clampFrame = (value: number) => Math.max(firstFrame, Math.min(lastFrame, value));
  const constrained = { ...args };
  if (Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length) {
    constrained.sourceTimesMs = args.sourceTimesMs.map((value) =>
      Math.round((clampFrame((Number(value) / 1000) * fps) / fps) * 1000));
  } else if (Array.isArray(args.frames) && args.frames.length) {
    constrained.frames = args.frames.map((value) => clampFrame(Number(value)));
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    constrained.seconds = args.seconds.map((value) => clampFrame(Number(value) * fps) / fps);
  } else {
    const requestedFrom = typeof args.fromSeconds === 'number'
      ? args.fromSeconds * fps
      : window.startFrame;
    const requestedTo = typeof args.toSeconds === 'number'
      ? args.toSeconds * fps
      : window.endFrame;
    constrained.fromSeconds = Math.max(window.startFrame, requestedFrom) / fps;
    constrained.toSeconds = Math.max(
      Math.max(window.startFrame, requestedFrom) + 1,
      Math.min(window.endFrame, requestedTo),
    ) / fps;
  }
  return constrained;
}

interface AssetFrameTarget {
  asset: MediaAsset;
  item?: TimelineItem;
  base: Timeline;
  sourceWindow: SourceFrameWindow;
}

function resolveAssetFrameTarget(args: Args, ctx: AgentContext): AssetFrameTarget | { error: string } {
  const assetQuery = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  const itemQuery = typeof args.itemId === 'string' ? args.itemId.trim() : '';
  if (!assetQuery && !itemQuery) {
    return { error: 'view_asset_frames requires assetId or itemId' };
  }
  const doc = ctx.getDoc();
  let base: Timeline;
  try {
    base = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  let item: TimelineItem | undefined;
  if (itemQuery) {
    const exact = base.items.find((candidate) => candidate.id === itemQuery);
    const matches = exact ? [exact] : base.items.filter((candidate) => candidate.id.startsWith(itemQuery));
    if (matches.length !== 1) {
      return { error: matches.length ? `ambiguous item prefix "${itemQuery}"` : `no item ${itemQuery}` };
    }
    item = matches[0]!;
  }

  const itemAsset = item
    ? doc.assets.find((asset) =>
      (item!.src && asset.src === item!.src) || (item!.templateId && asset.id === item!.templateId))
    : undefined;
  const exactAsset = assetQuery
    ? doc.assets.find((asset) => asset.id === assetQuery)
    : itemAsset;
  const assetMatches = exactAsset
    ? [exactAsset]
    : assetQuery
      ? doc.assets.filter((asset) => asset.id.startsWith(assetQuery))
      : [];
  if (assetMatches.length !== 1) {
    return {
      error: assetMatches.length
        ? `ambiguous asset prefix "${assetQuery}"`
        : item
          ? `item ${item.id} has no matching media-pool source asset`
          : `no asset ${assetQuery}`,
    };
  }
  const asset = assetMatches[0]!;
  if (item && itemAsset?.id !== asset.id) {
    return { error: `asset ${asset.id} is not the source of item ${item.id}` };
  }
  const rawWindow = item
    ? sourceWindowForTimelineRange(item, 0, item.durationInFrames)
    : { startFrame: 0, endFrame: Math.max(1, asset.durationInFrames) };
  const sourceWindow = {
    startFrame: Math.min(Math.max(0, asset.durationInFrames), rawWindow.startFrame),
    endFrame: Math.min(Math.max(0, asset.durationInFrames), rawWindow.endFrame),
  };
  if (sourceWindow.endFrame <= sourceWindow.startFrame) {
    return { error: `item ${item?.id ?? asset.id} has no visible source frames` };
  }
  return { asset, item, base, sourceWindow };
}


type ImagePayload = {
  __images: { frame: number; base64: string }[];
  frames: number[];
  layout: 'contact_sheet' | 'individual';
  note: string;
  coordinateSpace?: 'timeline' | 'source';
  timelineId?: string;
  assetId?: string;
  itemId?: string;
  sourceWindow?: SourceFrameWindow;
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
  project?: ProjectDoc,
  timelineId?: string,
): Promise<ImagePayload | { error: string }> {
  try {
    const res = await fetch('/render-still', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames, grid: true, fps: state.fps, ...(project && timelineId ? { project, timelineId } : {}) }),
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
    return { error: `render-still 请求失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Fast path: ffmpeg contact sheet for uploaded video masters. */
async function extractAssetContactSheet(
  src: string,
  args: Args,
  asset: MediaAsset,
  fps: number,
  metadata: Pick<ImagePayload, 'coordinateSpace' | 'assetId' | 'itemId' | 'sourceWindow'>,
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
        `源资产「${asset.name}」contact sheet`,
        data.sampleCount ? `${data.sampleCount} samples` : '',
        labelLine,
        '（未进时间线合成；每格≈对应源时间区间中点）',
      ].filter(Boolean).join(' · '),
      renderedBy: data.renderedBy ?? 'ffmpeg',
      sampleCount: data.sampleCount,
      sourceTimesMs,
      ...metadata,
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
  let total: number;
  const project = ctx.getDoc();
  try {
    state = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
    total = resolveTimelineRenderPlan(project, state.id).durationInFrames;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (total <= 0 || !state.items.length) {
    return { error: 'timeline is empty — nothing to render' };
  }
  const frames = pickFrames(args, total, state.fps, DEFAULT_TIMELINE_SCAN);
  const note = `时间线「${state.name}」${frames.length} 帧（绝对时间线坐标 f${frames.join(', f')}，共 ${total} @${state.fps}fps）——目标时间线草稿合成画面（含未提交编辑）`;
  const rendered = await renderStills(state, frames, note, project, state.id);
  return 'error' in rendered
    ? rendered
    : { ...rendered, coordinateSpace: 'timeline', timelineId: state.id };
}

async function viewAssetFrames(args: Args, ctx: AgentContext): Promise<unknown> {
  const target = resolveAssetFrameTarget(args, ctx);
  if ('error' in target) return target;
  const { asset, item, base, sourceWindow } = target;
  if (asset.kind === 'audio') {
    return { error: `asset "${asset.name}" is audio — it has no frames to render` };
  }

  const fps = base.fps || 30;
  const constrainedArgs = constrainSourceFrameArgs(args, sourceWindow, fps);
  const metadata: Pick<ImagePayload, 'coordinateSpace' | 'assetId' | 'itemId' | 'sourceWindow'> = {
    coordinateSpace: 'source',
    assetId: asset.id,
    itemId: item?.id,
    sourceWindow,
  };
  const windowNote = item
    ? `item ${item.id} 可见源窗口 [${sourceWindow.startFrame}, ${sourceWindow.endFrame})`
    : `完整源窗口 [${sourceWindow.startFrame}, ${sourceWindow.endFrame})`;

  // Upload-in-progress placeholder: sample from blob: in the browser (no server path yet).
  if (isBlobishSrc(asset.src)) {
    if (asset.kind === 'image' || asset.kind === 'svg') {
      const base64 = await extractBlobImagePreview(asset.src);
      if (base64) {
        return {
          __images: [{ frame: 0, base64 }],
          frames: [0],
          layout: 'individual',
          note: `源资产「${asset.name}」blob 预览 · ${windowNote}`,
          renderedBy: 'browser-blob',
          ...metadata,
        };
      }
    }
    if (asset.kind === 'video' || asset.kind === 'gif') {
      const count = Math.max(
        1,
        Math.min(MAX_FRAMES, Math.round(Number(constrainedArgs.count) || DEFAULT_ASSET_SCAN)),
      );
      const sourceTimesMs = Array.isArray(constrainedArgs.sourceTimesMs)
        ? constrainedArgs.sourceTimesMs.map(Number).filter((value) => Number.isFinite(value))
        : Array.isArray(constrainedArgs.seconds)
          ? constrainedArgs.seconds.map((seconds) => Math.round(Number(seconds) * 1000))
          : Array.isArray(constrainedArgs.frames)
            ? constrainedArgs.frames.map((frame) => Math.round((Number(frame) / fps) * 1000))
            : undefined;
      const sheet = await extractBlobContactSheet(asset.src, {
        sourceTimesMs,
        count,
        fromMs: typeof constrainedArgs.fromSeconds === 'number'
          ? Math.round(constrainedArgs.fromSeconds * 1000)
          : undefined,
        toMs: typeof constrainedArgs.toSeconds === 'number'
          ? Math.round(constrainedArgs.toSeconds * 1000)
          : undefined,
      });
      if (sheet) {
        const labelLine = sheet.labels.map((label, index) => `[${index + 1}]${label}`).join(' ');
        return {
          __images: [{ frame: 0, base64: sheet.base64 }],
          frames: sheet.sourceTimesMs.map((ms) => Math.round((ms / 1000) * fps)),
          layout: sheet.sampleCount > 1 ? 'contact_sheet' : 'individual',
          note: `源资产「${asset.name}」blob contact sheet · ${sheet.sampleCount} samples · cells L→R T→B: ${labelLine} · ${windowNote}`,
          renderedBy: 'browser-blob',
          sampleCount: sheet.sampleCount,
          sourceTimesMs: sheet.sourceTimesMs,
          ...metadata,
        };
      }
    }
  }

  // Prefer fast ffmpeg contact sheet for uploaded video/gif masters.
  if (asset.src) {
    const sheet = await extractAssetContactSheet(
      asset.src,
      constrainedArgs,
      asset,
      fps,
      metadata,
    );
    if (sheet && !('error' in sheet)) {
      return { ...sheet, note: `${sheet.note} · ${windowNote}` };
    }
  }

  const track = defaultTrackId(base, 'video');
  if (!track) return { error: 'no video track to render the asset preview on' };
  const total = Math.max(1, asset.durationInFrames);
  const frames = pickFrames(
    constrainedArgs,
    total,
    fps,
    asset.kind === 'video' || asset.kind === 'gif' ? DEFAULT_ASSET_SCAN : 1,
  );
  const state = assetPreviewState(base, asset, track);
  const note = `源资产「${asset.name}」${frames.length} 帧（源坐标 f${frames.join(', f')}，共 ${total}）——单独预览，未合成到时间线 · ${windowNote}`;
  const rendered = await renderStills(state, frames, note);
  return 'error' in rendered ? rendered : { ...rendered, ...metadata };
}

export async function execFramesTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  const result = name === 'view_timeline_frames'
    ? await viewTimelineFrames(args, ctx)
    : name === 'view_asset_frames'
      ? await viewAssetFrames(args, ctx)
      : { error: `unknown tool ${name}` };
  return await maybeDescribeFramesResult(
    result,
    name === 'view_asset_frames' ? 'asset-frames' : 'timeline-frames',
  );
}
