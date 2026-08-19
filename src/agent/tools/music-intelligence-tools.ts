export {
  MUSIC_INTELLIGENCE_TOOL_NAMES,
  MUSIC_INTELLIGENCE_TOOL_SCHEMAS,
} from './schemas/music-intelligence-tools';

import type { AgentContext } from '../context';
import type { AtomicAction } from '../../editor/reduce';
import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import type { MusicEditPlan } from '../../audio/intelligence/types';
import { loadMusicAnalysisForAsset, musicAnalysisRef } from '../../audio/intelligence/store';
import {
  MAX_MUSIC_IMAGE_PLACEMENTS,
  MAX_MUSIC_PLAN_TARGETS,
  analyzeMusic,
  buildMusicEditPlan,
  buildMusicImagePlacementPlan,
  inspectMusic,
  normalizeImagePlanOptions,
  normalizePlanOptions,
  resolveMusicTarget,
  unavailableAnalysis,
  type Args,
  type BuiltImagePlan,
  type BuiltPlan,
  type MusicImageEditPlan,
} from './music-intelligence-plan';
export {
  MAX_MUSIC_IMAGE_PLACEMENTS,
  MAX_MUSIC_PLAN_CUTS,
  MAX_MUSIC_PLAN_TARGETS,
  buildMusicEditPlan,
  buildMusicImagePlacementPlan,
} from './music-intelligence-plan';
export type {
  MusicImageEditPlan,
  MusicImagePlacement,
  MusicImagePlanOptions,
  MusicPlanDensity,
  MusicPlanOptions,
  RequestedMusicTiming,
} from './music-intelligence-plan';

interface ImagePlacementActions {
  readonly actions: AtomicAction[];
  readonly trackLocked: boolean;
  readonly conflictingItemIds: string[];
  readonly missingAssetIds: string[];
}

export function buildMusicImagePlacementActions(
  plan: MusicImageEditPlan,
  state: TimelineState,
  assets: readonly MediaAsset[],
): ImagePlacementActions {
  const assetById = new Map(assets.filter((asset) => asset.kind === 'image').map((asset) => [asset.id, asset]));
  const missingAssetIds = [...new Set(plan.placements
    .map((placement) => placement.assetId)
    .filter((assetId) => !assetById.has(assetId)))];
  const conflictingItemIds = [...new Set(state.items
    .filter((item) => item.track === plan.track && item.startFrame < plan.range.toFrame
      && item.startFrame + item.durationInFrames > plan.range.fromFrame)
    .map((item) => item.id))];
  const trackLocked = state.tracks?.[plan.track]?.locked === true;
  if (trackLocked || conflictingItemIds.length || missingAssetIds.length) {
    return { actions: [], trackLocked, conflictingItemIds, missingAssetIds };
  }
  const actions: AtomicAction[] = plan.placements.flatMap((placement) => {
    const asset = assetById.get(placement.assetId);
    if (!asset) return [];
    const item: Omit<TimelineItem, 'startFrame'> = {
      id: `item_${crypto.randomUUID()}`,
      track: plan.track,
      durationInFrames: placement.durationInFrames,
      kind: 'image',
      name: asset.name,
      src: asset.src,
      sourceAssetId: asset.id,
      sourceFilename: asset.sourceFilename,
      originalFilePath: asset.originalFilePath,
      sourceRevision: asset.sourceRevision,
      sourceContentHash: asset.sourceContentHash,
      width: asset.width,
      height: asset.height,
    };
    return [{ type: 'add', item, startFrame: placement.startFrame } satisfies AtomicAction];
  });
  return { actions, trackLocked, conflictingItemIds, missingAssetIds };
}
export function staleMusicAnalysisResult(
  supplied: unknown,
  current: string,
  planToolName = 'music_edit_plan',
): Record<string, unknown> | null {
  if (typeof supplied !== 'string' || supplied === current) return null;
  return {
    error: `stale music analysisRef; call ${planToolName} again before editing`,
    staleAnalysisRef: true,
    currentAnalysisRef: current,
  };
}

async function currentPlan(
  args: Args,
  ctx: AgentContext,
  requireAnalysisRef = false,
): Promise<BuiltPlan | Record<string, unknown>> {
  const target = resolveMusicTarget({ itemId: args.itemId }, ctx);
  if (!target.item) throw new Error('itemId is required for a music edit plan');
  const analysis = await loadMusicAnalysisForAsset(target.asset);
  if (!analysis) return await unavailableAnalysis(target.asset);
  const ref = musicAnalysisRef(analysis);
  if (requireAnalysisRef && typeof args.analysisRef !== 'string') {
    return { error: 'analysisRef is required; call music_edit_plan before editing', missingAnalysisRef: true };
  }
  const stale = staleMusicAnalysisResult(args.analysisRef, ref);
  if (stale) return stale;
  return buildMusicEditPlan(analysis, ref, target.item, ctx.getState(), normalizePlanOptions(args));
}

async function currentImagePlan(
  args: Args,
  ctx: AgentContext,
  requireAnalysisRef = false,
): Promise<BuiltImagePlan | Record<string, unknown>> {
  const target = resolveMusicTarget({ itemId: args.itemId }, ctx);
  if (!target.item) throw new Error('itemId is required for a music image plan');
  const analysis = await loadMusicAnalysisForAsset(target.asset);
  if (!analysis) return await unavailableAnalysis(target.asset);
  const ref = musicAnalysisRef(analysis);
  if (requireAnalysisRef && typeof args.analysisRef !== 'string') {
    return { error: 'analysisRef is required; call music_image_plan before editing', missingAnalysisRef: true };
  }
  const stale = staleMusicAnalysisResult(args.analysisRef, ref, 'music_image_plan');
  if (stale) return stale;
  return buildMusicImagePlacementPlan(
    analysis,
    ref,
    target.item,
    ctx.getState(),
    ctx.getDoc().assets,
    normalizeImagePlanOptions(args),
  );
}

function planResponse(built: BuiltPlan): Record<string, unknown> {
  return {
    ...built.plan,
    summary: {
      cuts: built.plan.cutFrames.length,
      targets: built.plan.targetItemIds.length,
      overlappingTargets: built.overlappingTargetCount,
      lockedTargets: built.lockedTargetCount,
      availableCuts: built.availableCutCount,
      timing: built.plan.timing,
      capped: built.availableCutCount > built.plan.cutFrames.length || built.targetLimitReached,
    },
  };
}

function isBuiltPlan(value: BuiltPlan | Record<string, unknown>): value is BuiltPlan {
  return 'plan' in value;
}

function isBuiltImagePlan(value: BuiltImagePlan | Record<string, unknown>): value is BuiltImagePlan {
  return 'plan' in value;
}

function imagePlanResponse(built: BuiltImagePlan): Record<string, unknown> {
  return {
    ...built.plan,
    summary: {
      placements: built.plan.placements.length,
      images: built.imageCount,
      availableCuts: built.availableCutCount,
      timing: built.plan.timing,
      capped: built.availableCutCount > Math.max(0, MAX_MUSIC_IMAGE_PLACEMENTS - 1),
    },
  };
}

export function buildMusicSplitActions(
  plan: MusicEditPlan,
  state: TimelineState,
): { actions: AtomicAction[]; lockedIds: string[]; editableIds: string[] } {
  const actions: AtomicAction[] = [];
  const lockedIds: string[] = [];
  const editableIds: string[] = [];
  for (const id of plan.targetItemIds) {
    const item = state.items.find((candidate) => candidate.id === id && candidate.kind === 'video');
    if (!item) continue;
    if (state.tracks?.[item.track]?.locked) {
      lockedIds.push(item.id);
      continue;
    }
    const cuts = plan.cutFrames
      .filter((frame) => frame > item.startFrame && frame < item.startFrame + item.durationInFrames)
      .sort((a, b) => b - a);
    if (cuts.length) editableIds.push(item.id);
    for (const atFrame of cuts) {
      actions.push({ type: 'split', id: item.id, atFrame, newId: `item_${crypto.randomUUID()}` });
    }
  }
  return { actions, lockedIds, editableIds };
}

async function syncCuts(args: Args, ctx: AgentContext): Promise<unknown> {
  const built = await currentPlan(args, ctx, true);
  if (!isBuiltPlan(built)) return built;
  const prepared = buildMusicSplitActions(built.plan, ctx.getState());
  if (!prepared.actions.length) {
    return {
      ok: true,
      changed: false,
      analysisRef: built.plan.analysisRef,
      reason: prepared.lockedIds.length
        ? 'all planned target clips are on locked tracks; unlock them and retry'
        : 'no planned cut falls inside an editable video clip',
      lockedTargetIds: prepared.lockedIds.slice(0, MAX_MUSIC_PLAN_TARGETS),
    };
  }
  ctx.commands.batch(prepared.actions, '音乐卡点切分');
  return {
    ok: true,
    changed: true,
    analysisRef: built.plan.analysisRef,
    splitCount: prepared.actions.length,
    targetCount: prepared.editableIds.length,
    timing: built.plan.timing,
    range: built.plan.range,
    lockedTargetIds: prepared.lockedIds.slice(0, MAX_MUSIC_PLAN_TARGETS),
  };
}

async function syncImages(args: Args, ctx: AgentContext): Promise<unknown> {
  const built = await currentImagePlan(args, ctx, true);
  if (!isBuiltImagePlan(built)) return built;
  const prepared = buildMusicImagePlacementActions(built.plan, ctx.getState(), ctx.getDoc().assets);
  if (prepared.missingAssetIds.length) {
    return {
      error: 'some planned image assets are no longer in the media pool; rebuild the music image plan',
      changed: false,
      missingAssetIds: prepared.missingAssetIds,
    };
  }
  if (prepared.trackLocked) {
    return {
      ok: true,
      changed: false,
      analysisRef: built.plan.analysisRef,
      reason: `target video track ${built.plan.track} is locked; unlock it or choose another track`,
      track: built.plan.track,
    };
  }
  if (prepared.conflictingItemIds.length) {
    return {
      error: `target video track ${built.plan.track} is occupied in the requested range; choose an empty track`,
      changed: false,
      track: built.plan.track,
      conflictingItemIds: prepared.conflictingItemIds.slice(0, MAX_MUSIC_PLAN_TARGETS),
    };
  }
  if (!prepared.actions.length) {
    return {
      ok: true,
      changed: false,
      analysisRef: built.plan.analysisRef,
      reason: 'no image placements were produced for the requested music range',
    };
  }
  ctx.commands.batch(prepared.actions, '按音乐卡点插入图片');
  return {
    ok: true,
    changed: true,
    analysisRef: built.plan.analysisRef,
    track: built.plan.track,
    placementCount: prepared.actions.length,
    imageAssetIds: built.plan.imageAssetIds,
    timing: built.plan.timing,
    range: built.plan.range,
  };
}

export async function execMusicIntelligenceTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  try {
    if (name === 'analyze_music') return await analyzeMusic(args, ctx);
    if (name === 'inspect_music') return await inspectMusic(args, ctx);
    if (name === 'music_edit_plan') {
      const built = await currentPlan(args, ctx);
      return isBuiltPlan(built) ? planResponse(built) : built;
    }
    if (name === 'sync_cuts_to_music') return await syncCuts(args, ctx);
    if (name === 'music_image_plan') {
      const built = await currentImagePlan(args, ctx);
      return isBuiltImagePlan(built) ? imagePlanResponse(built) : built;
    }
    if (name === 'sync_images_to_music') return await syncImages(args, ctx);
    return { error: `unknown tool ${name}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
