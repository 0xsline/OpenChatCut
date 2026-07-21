import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { AtomicAction } from '../../editor/reduce';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import type { SceneChange } from '../../scene-detection/detect';

type Args = Record<string, unknown>;
type ApplyMode = 'report' | 'markers' | 'split';

export const SCENE_DETECTION_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'detect_scenes',
  description: [
    'Detect visual scene changes in one source video using local FFmpeg acceleration.',
    'Pass itemId to inspect a timeline clip (trim and speed are mapped correctly), or assetId for a media-pool-only report.',
    'apply=markers creates item-scoped timeline markers; apply=split cuts the clip at every accepted scene boundary as one undoable edit.',
    'Default apply=report. Use threshold 0.2 for sensitive detection, 0.3 balanced, 0.45 conservative.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Timeline video/gif item id (prefix accepted). Required for markers/split.' },
      assetId: { type: 'string', description: 'Media-pool video/gif asset id (prefix accepted). Report only unless itemId is also supplied.' },
      threshold: { type: 'number', description: 'Scene sensitivity threshold 0.05–0.95; lower finds more changes. Default 0.3.' },
      minSceneSeconds: { type: 'number', description: 'Minimum distance between cuts. Default 0.75s.' },
      maxScenes: { type: 'number', description: 'Maximum returned/applied boundaries. Default 200, max 500.' },
      apply: { type: 'string', enum: ['report', 'markers', 'split'], description: 'report (default), markers, or split.' },
    },
  },
}];

export const SCENE_DETECTION_TOOL_NAMES = new Set(SCENE_DETECTION_TOOL_SCHEMAS.map((tool) => tool.name));

const prefixed = <T extends { id: string }>(items: readonly T[], value: unknown): T | null => {
  const id = String(value ?? '').trim();
  return id ? (items.find((item) => item.id === id || item.id.startsWith(id)) ?? null) : null;
};

function sourceFor(ctx: AgentContext, args: Args): { asset: MediaAsset | null; item: TimelineItem | null; src: string } | { error: string } {
  const state = ctx.getState();
  const item = prefixed(state.items, args.itemId);
  if (args.itemId && !item) return { error: `timeline item not found: ${String(args.itemId)}` };
  if (item && item.kind !== 'video' && item.kind !== 'gif') return { error: `item ${item.id} is ${item.kind}; scene detection requires video/gif` };
  const asset = prefixed(ctx.getDoc().assets, args.assetId)
    ?? (item?.src ? ctx.getDoc().assets.find((candidate) => candidate.src === item.src) ?? null : null);
  if (args.assetId && !asset) return { error: `media asset not found: ${String(args.assetId)}` };
  if (asset && asset.kind !== 'video' && asset.kind !== 'gif') return { error: `asset ${asset.id} is ${asset.kind}; scene detection requires video/gif` };
  const src = item?.src ?? asset?.src ?? '';
  if (!src) return { error: 'itemId or assetId is required and must resolve to a source video' };
  if (!src.startsWith('/media/uploads/')) {
    return { error: 'scene detection requires a persisted local media source under /media/uploads; finish uploading or relink the asset first' };
  }
  return { asset, item, src };
}

interface MappedScene extends SceneChange {
  timelineFrame: number;
  itemLocalFrame: number;
}

function mapScenesToItem(scenes: readonly SceneChange[], item: TimelineItem, fps: number): MappedScene[] {
  const sourceIn = item.srcInFrame ?? 0;
  const rate = Math.max(0.01, item.playbackRate ?? 1);
  const mapped = scenes.flatMap((scene): MappedScene[] => {
    const sourceFrame = (scene.timeMs / 1000) * fps;
    const itemLocalFrame = Math.round((sourceFrame - sourceIn) / rate);
    if (itemLocalFrame <= 0 || itemLocalFrame >= item.durationInFrames) return [];
    return [{ ...scene, itemLocalFrame, timelineFrame: item.startFrame + itemLocalFrame }];
  });
  const unique = new Map(mapped.map((scene) => [scene.timelineFrame, scene]));
  return [...unique.values()].sort((a, b) => a.timelineFrame - b.timelineFrame);
}

function markerActions(item: TimelineItem, scenes: readonly MappedScene[]): AtomicAction[] {
  return scenes.map((scene, index) => ({
    type: 'addMarker',
    marker: {
      id: `marker_${crypto.randomUUID()}`,
      scope: 'item',
      itemId: item.id,
      fromFrame: scene.timelineFrame,
      durationFrames: 0,
      note: `Scene ${index + 1} · ${scene.kind} · score ${scene.score.toFixed(3)}`,
      color: scene.kind === 'cut' ? 'yellow' : 'purple',
    },
  }));
}

function splitActions(item: TimelineItem, scenes: readonly MappedScene[]): AtomicAction[] {
  let currentId = item.id;
  return scenes.map((scene) => {
    const nextId = `item_${crypto.randomUUID()}`;
    const action: AtomicAction = {
      type: 'split', id: currentId, atFrame: scene.timelineFrame, newId: nextId,
    };
    currentId = nextId;
    return action;
  });
}

export async function execSceneDetectionTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'detect_scenes') return { error: `unknown tool ${name}` };
  const target = sourceFor(ctx, args);
  if ('error' in target) return target;
  const apply = (args.apply === 'markers' || args.apply === 'split' ? args.apply : 'report') as ApplyMode;
  if (apply !== 'report' && !target.item) return { error: `apply=${apply} requires itemId so source cuts can be mapped onto the timeline` };
  if (target.item && ctx.getState().tracks?.[target.item.track]?.locked && apply !== 'report') {
    return { error: `track containing ${target.item.id} is locked` };
  }

  const minSceneSeconds = Number(args.minSceneSeconds);
  const body = {
    src: target.src,
    threshold: Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : undefined,
    minSceneMs: Number.isFinite(minSceneSeconds) ? Math.round(minSceneSeconds * 1000) : undefined,
    maxScenes: Number.isFinite(Number(args.maxScenes)) ? Number(args.maxScenes) : undefined,
  };
  const response = await fetch('/api/detect-scenes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
    durationMs?: number;
    threshold?: number;
    minSceneMs?: number;
    scenes?: SceneChange[];
  };
  if (!response.ok) return { error: result.error ?? `scene detection failed (${response.status})` };
  const scenes = result.scenes ?? [];
  const mapped = target.item ? mapScenesToItem(scenes, target.item, ctx.getState().fps) : [];

  if (target.item && apply !== 'report' && mapped.length) {
    const actions = apply === 'markers'
      ? markerActions(target.item, mapped)
      : splitActions(target.item, mapped);
    ctx.commands.batch(actions, apply === 'markers' ? 'Add scene markers' : 'Split clip at scene changes');
  }

  return {
    ok: true,
    apply,
    assetId: target.asset?.id ?? null,
    itemId: target.item?.id ?? null,
    durationMs: result.durationMs ?? null,
    threshold: result.threshold ?? null,
    minSceneMs: result.minSceneMs ?? null,
    detectedCount: scenes.length,
    applicableCount: target.item ? mapped.length : null,
    appliedCount: apply === 'report' ? 0 : mapped.length,
    scenes: target.item
      ? mapped.map((scene) => ({
          sourceTimeMs: scene.timeMs,
          timelineFrame: scene.timelineFrame,
          itemLocalFrame: scene.itemLocalFrame,
          score: scene.score,
          kind: scene.kind,
        }))
      : scenes.map((scene) => ({ sourceTimeMs: scene.timeMs, score: scene.score, kind: scene.kind })),
  };
}
