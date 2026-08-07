import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import {
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
} from '../../editor/types';
import { sourceFrameAt } from '../../editor/sourceLimit';
import {
  safeBoxForRange,
  projectGeometryThroughItem,
  transformFromSafeBox,
} from '../../geometry/placement';
import { analyzeAssetGeometry, type VisualGeometryAsset } from '../../geometry/visual-geometry';

type Args = Record<string, unknown>;

export const PLACE_GRAPHICS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'place_graphics_in_safe_zone',
    description: [
      'Move overlay graphics (motion-graphic / text / solid clips) into the safe zone of the video underneath: ',
      'visual geometry (person segmentation + face) picks the largest empty area in each clip\'s time window, ',
      'and the clip\'s transform (x/y % of canvas, scale) is written to center it there. Face is never covered.',
      'Uses the geometry cache; first call analyzes the underlying video (a few seconds).',
      'Call when overlays cover the speaker, or after adding graphics to a talking-head video.',
      'Pass itemId to place one clip, or omit to place every overlay graphic.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Optional: place only this clip (full id or unique prefix).' },
      },
    },
  },
];

export const PLACE_GRAPHICS_TOOL_NAMES: ReadonlySet<string> = new Set(PLACE_GRAPHICS_TOOL_SCHEMAS.map((tool) => tool.name));

const GRAPHIC_KINDS: Record<string, true> = {
  'motion-graphic': true,
  text: true,
  solid: true,
};
const DEFAULT_GRAPHIC_ASPECT = 16 / 9;

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  const exact = items.find((item) => item.id === q);
  if (exact) return exact;
  const matches = items.filter((item) => item.id.startsWith(q));
  return matches.length === 1 ? matches[0]! : null;
}

/** Pick the nearest visible video layer below the graphic with time overlap. */
export function pickUnderlyingVideo(
  state: TimelineState,
  graphic: TimelineItem,
  fromFrame: number,
  toFrame: number,
): TimelineItem | null {
  const visualTracks = timelineTrackIds(state).filter((trackId) => trackKind(state, trackId) === 'video');
  const graphicLayer = visualTracks.indexOf(graphic.track);
  let best: TimelineItem | null = null;
  let bestLayer = Number.POSITIVE_INFINITY;
  let bestOverlap = 0;
  for (const item of state.items) {
    if (item.kind !== 'video' || state.tracks?.[item.track]?.hidden) continue;
    const layer = visualTracks.indexOf(item.track);
    if (layer < 0 || (graphicLayer >= 0 && layer <= graphicLayer)) continue;
    const overlap = Math.min(toFrame, item.startFrame + item.durationInFrames)
      - Math.max(fromFrame, item.startFrame);
    if (overlap <= 0) continue;
    if (layer < bestLayer || (layer === bestLayer && overlap > bestOverlap)) {
      best = item;
      bestLayer = layer;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Source-seconds window of the video clip covered by the graphic's frames. */
function sourceWindowOf(
  video: TimelineItem,
  graphicFrom: number,
  graphicTo: number,
  fps: number,
): { startSec: number; endSec: number } | null {
  const videoStart = video.startFrame;
  const videoEnd = video.startFrame + video.durationInFrames;
  const localStart = Math.max(graphicFrom, videoStart) - videoStart;
  const localEnd = Math.min(graphicTo, videoEnd) - videoStart;
  if (localEnd <= localStart || fps <= 0) return null;
  return {
    startSec: sourceFrameAt(video, localStart) / fps,
    endSec: sourceFrameAt(video, localEnd) / fps,
  };
}

function graphicAspectOf(item: TimelineItem): number {
  return item.width && item.height && item.width > 0 && item.height > 0
    ? item.width / item.height
    : DEFAULT_GRAPHIC_ASPECT;
}

export function canPlaceGraphic(state: TimelineState, item: TimelineItem): boolean {
  const track = state.tracks?.[item.track];
  return !track?.hidden && !track?.locked;
}

export async function execPlaceGraphicsTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'place_graphics_in_safe_zone') return { error: `unknown tool ${name}` };
  const state = ctx.getState();
  const doc = ctx.getDoc();
  const fps = state.fps || 30;

  const requested = typeof args.itemId === 'string' && args.itemId.trim() ? args.itemId.trim() : null;
  const graphics = state.items.filter((item) => GRAPHIC_KINDS[item.kind]);
  const targets = requested
    ? (() => {
      const item = findItem(graphics, requested);
      return item ? [item] : [];
    })()
    : graphics;
  if (requested && !targets.length) {
    return { error: `没有找到图形类 clip ${requested}（可用类型：motion-graphic/text/solid）`, available: graphics.map((g) => ({ itemId: g.id, name: g.name, kind: g.kind })) };
  }
  if (!targets.length) {
    return { ok: true, adjusted: 0, note: '时间线上没有可摆放的叠加图形（motion-graphic/text/solid）。' };
  }

  const geometryBySrc = new Map<string, VisualGeometryAsset | null>();
  const placed: Array<{ itemId: string; name: string; x: number; y: number; scale: number }> = [];
  const skipped: string[] = [];
  for (const item of targets) {
    if (!canPlaceGraphic(state, item)) {
      skipped.push(`${item.name}（轨道已隐藏或锁定）`);
      continue;
    }
    const from = item.startFrame;
    const to = item.startFrame + item.durationInFrames;
    const video = pickUnderlyingVideo(state, item, from, to);
    if (!video?.src) {
      skipped.push(`${item.name}（下方无视频素材）`);
      continue;
    }
    let geometry = geometryBySrc.get(video.src);
    if (geometry === undefined) {
      const asset = doc.assets.find((candidate) => candidate.src === video.src);
      if (!asset) {
        skipped.push(`${item.name}（视频素材不在媒体池）`);
        continue;
      }
      const result = await analyzeAssetGeometry(asset);
      geometry = result.geometry;
      geometryBySrc.set(video.src, geometry);
    }
    if (!geometry) {
      skipped.push(`${item.name}（几何不可用）`);
      continue;
    }
    const window = sourceWindowOf(video, from, to, fps);
    if (!window) {
      skipped.push(`${item.name}（与视频无时间重叠）`);
      continue;
    }
    const projectedGeometry = projectGeometryThroughItem(geometry, state, video);
    const box = safeBoxForRange(projectedGeometry, window.startSec, window.endSec);
    const transform = box ? transformFromSafeBox(box, graphicAspectOf(item)) : null;
    if (!transform) {
      skipped.push(`${item.name}（安全区不足以容纳）`);
      continue;
    }
    ctx.commands.setItemTransform(item.id, { x: transform.x, y: transform.y, scale: transform.scale });
    placed.push({ itemId: item.id, name: item.name, x: transform.x, y: transform.y, scale: transform.scale });
  }

  return {
    ok: true,
    adjusted: placed.length,
    placed,
    ...(skipped.length ? { skipped } : {}),
    note: placed.length
      ? `已将 ${placed.length} 个图形移动到安全区（避开人脸/主体）。`
      : '没有图形被移动；' + (skipped.length ? `跳过：${skipped.join('；')}` : '安全区均已可用。'),
  };
}
