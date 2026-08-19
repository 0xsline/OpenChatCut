import type { AgentContext } from '../context';
import {
  defaultTrackId,
  resolveTrackId,
  type MediaAsset,
  type TimelineItem,
  type TimelineState,
} from '../../editor/types';
import {
  sourceFramesToTimelineFrames,
  sourceWindowForTimelineRange,
} from '../../editor/sourceLimit';
import type { MusicAnalysis, MusicEditPlan } from '../../audio/intelligence/types';
import {
  loadMusicAnalysisForAsset,
  musicAnalysisRef,
} from '../../audio/intelligence/store';
import { enqueueMusicAnalysis, musicAnalysisStatus } from '../../audio/intelligence/jobs';
import { fetchModelPackCatalog, modelPackInstallGuidance } from '../../../shared/model-packs';

const MAX_INSPECT_BEATS = 48;
const MAX_INSPECT_DOWNBEATS = 24;
const MAX_INSPECT_SECTIONS = 16;
const MAX_INSPECT_TAGS = 12;
export const MAX_MUSIC_PLAN_CUTS = 96;
export const MAX_MUSIC_PLAN_TARGETS = 64;
export const MAX_MUSIC_IMAGE_PLACEMENTS = 96;
const MAX_MUSIC_IMAGE_ASSETS = 64;

const DENSITY_STRIDE: Record<MusicPlanDensity, number> = {
  sparse: 4,
  medium: 2,
  dense: 1,
};

export type Args = Record<string, unknown>;
export type MusicPlanDensity = 'sparse' | 'medium' | 'dense';
export type RequestedMusicTiming = MusicEditPlan['timing'] | 'auto';

export interface MusicPlanOptions {
  readonly timing: RequestedMusicTiming;
  readonly density: MusicPlanDensity;
  readonly fromFrame?: number;
  readonly toFrame?: number;
  readonly targetItemIds?: readonly string[];
}

export interface MusicImagePlanOptions extends MusicPlanOptions {
  readonly imageAssetIds?: readonly string[];
  readonly track?: string;
}

export interface MusicImagePlacement {
  readonly assetId: string;
  readonly startFrame: number;
  readonly durationInFrames: number;
}

export interface MusicImageEditPlan {
  readonly schemaVersion: 1;
  readonly analysisRef: string;
  readonly musicItemId: string;
  readonly imageAssetIds: string[];
  readonly track: string;
  readonly timing: MusicEditPlan['timing'];
  readonly range: MusicEditPlan['range'];
  readonly placements: MusicImagePlacement[];
}

interface ResolvedMusicTarget {
  readonly asset: MediaAsset;
  readonly item?: TimelineItem;
}

export interface BuiltPlan {
  readonly plan: MusicEditPlan;
  readonly availableCutCount: number;
  readonly overlappingTargetCount: number;
  readonly lockedTargetCount: number;
  readonly targetLimitReached: boolean;
}

export interface BuiltImagePlan {
  readonly plan: MusicImageEditPlan;
  readonly availableCutCount: number;
  readonly imageCount: number;
}

function resolvePrefix<T extends { readonly id: string }>(
  values: readonly T[],
  query: string,
  label: string,
): T {
  const displayQuery = query.slice(0, 80);
  const exact = values.find((value) => value.id === query);
  if (exact) return exact;
  const matches = values.filter((value) => value.id.startsWith(query));
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) throw new Error(`${label} id prefix ${displayQuery} is ambiguous`);
  throw new Error(`no ${label} ${displayQuery}`);
}

function resolveAssetForItem(item: TimelineItem, assets: readonly MediaAsset[]): MediaAsset {
  if (item.sourceAssetId) {
    const byId = assets.find((asset) => asset.id === item.sourceAssetId);
    if (byId) return byId;
  }
  if (item.src) {
    const bySource = assets.filter((asset) => asset.src === item.src);
    if (bySource.length === 1 && bySource[0]) return bySource[0];
  }
  throw new Error(`clip ${item.id} is not linked to a unique media-pool asset; relink it before music analysis`);
}

export function resolveMusicTarget(args: Args, ctx: AgentContext): ResolvedMusicTarget {
  const assetQuery = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  const itemQuery = typeof args.itemId === 'string' ? args.itemId.trim() : '';
  if (assetQuery && itemQuery) throw new Error('pass assetId or itemId, not both');
  if (itemQuery) {
    const item = resolvePrefix(ctx.getState().items, itemQuery, 'timeline item');
    if (item.kind !== 'audio' && item.kind !== 'video') {
      throw new Error(`clip ${item.id} is ${item.kind}; music analysis requires an audio/video clip`);
    }
    return { item, asset: resolveAssetForItem(item, ctx.getDoc().assets) };
  }
  if (assetQuery) {
    const asset = resolvePrefix(ctx.getDoc().assets, assetQuery, 'media-pool asset');
    if (asset.kind !== 'audio' && asset.kind !== 'video') {
      throw new Error(`asset ${asset.id} is ${asset.kind}; music analysis requires audio/video media`);
    }
    return { asset };
  }
  throw new Error('pass assetId (media pool) or itemId (timeline clip)');
}

export async function unavailableAnalysis(asset: MediaAsset): Promise<Record<string, unknown>> {
  const status = musicAnalysisStatus(asset.id);
  if (status.state === 'queued') {
    return { error: 'music analysis is queued; wait for it to finish, then call inspect_music again', assetId: asset.id };
  }
  if (status.state === 'running') {
    return {
      error: `music analysis is running (${status.phase}, ${Math.round(status.progress * 100)}%); retry after it finishes`,
      assetId: asset.id,
    };
  }
  if (status.state === 'error') return { error: status.message.slice(0, 320), assetId: asset.id };
  const required = ['rhythm-lite', 'music-semantics-lite'];
  try {
    const catalog = await fetchModelPackCatalog();
    const missing = catalog
      .filter((entry) => required.includes(entry.id) && entry.status !== 'installed')
      .map((entry) => ({ id: entry.id, status: entry.status }));
    if (missing.length) {
      return {
        error: `music analysis is unavailable until the model pack(s) are installed. ${modelPackInstallGuidance(missing)}`,
        assetId: asset.id,
        modelPacks: missing,
      };
    }
  } catch {
    // Catalog status is advisory here; cache absence remains the authoritative result.
  }
  return {
    error: 'music has not been analyzed yet; call analyze_music for this asset, then retry',
    assetId: asset.id,
    requiredModelPacks: required,
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function inspectRange(args: Args, durationMs: number): { fromMs: number; toMs: number } {
  const fromMs = Math.max(0, Math.round(finiteNumber(args.fromMs) ?? 0));
  const toMs = Math.min(durationMs, Math.round(finiteNumber(args.toMs) ?? durationMs));
  if (toMs <= fromMs) throw new Error('toMs must be greater than fromMs after clamping to the analyzed duration');
  return { fromMs, toMs };
}

function inMsRange(value: number, range: { fromMs: number; toMs: number }): boolean {
  return value >= range.fromMs && value < range.toMs;
}

function roundedTags(analysis: MusicAnalysis): Array<Record<string, unknown>> {
  return [...analysis.tags]
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, MAX_INSPECT_TAGS)
    .map((tag) => ({ kind: tag.kind, label: tag.label, score: Number(tag.score.toFixed(3)) }));
}

function listedSections(analysis: MusicAnalysis, range: { fromMs: number; toMs: number }) {
  return analysis.sections
    .filter((section) => section.toMs > range.fromMs && section.fromMs < range.toMs)
    .slice(0, MAX_INSPECT_SECTIONS)
    .map((section) => ({
      fromMs: section.fromMs,
      toMs: section.toMs,
      role: section.role,
      energy: Number(section.energy.toFixed(3)),
      confidence: Number(section.boundaryConfidence.toFixed(3)),
    }));
}

function mapSourceMsToTimelineFrame(ms: number, item: TimelineItem, fps: number): number | null {
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const sourceFrame = (ms / 1000) * fps;
  if (sourceFrame <= window.startFrame || sourceFrame >= window.endFrame) return null;
  const local = Math.round(sourceFramesToTimelineFrames(item, sourceFrame - window.startFrame));
  if (local <= 0 || local >= item.durationInFrames) return null;
  return item.startFrame + local;
}

function mapSourcePoints(pointsMs: readonly number[], item: TimelineItem, fps: number): number[] {
  const frames = pointsMs.flatMap((ms) => {
    const frame = mapSourceMsToTimelineFrame(ms, item, fps);
    return frame === null ? [] : [frame];
  });
  return [...new Set(frames)].sort((a, b) => a - b);
}

function inspectPointList(
  values: readonly number[],
  item: TimelineItem | undefined,
  fps: number,
  range: { fromMs: number; toMs: number },
  cap: number,
): number[] {
  const filtered = values.filter((value) => inMsRange(value, range));
  return item ? mapSourcePoints(filtered, item, fps).slice(0, cap) : filtered.slice(0, cap);
}

export async function inspectMusic(args: Args, ctx: AgentContext): Promise<unknown> {
  const target = resolveMusicTarget(args, ctx);
  const analysis = await loadMusicAnalysisForAsset(target.asset);
  if (!analysis) return await unavailableAnalysis(target.asset);
  const range = inspectRange(args, analysis.durationMs);
  const beatPoints = analysis.beatsMs.filter((value) => inMsRange(value, range));
  const downbeatPoints = analysis.downbeatsMs.filter((value) => inMsRange(value, range));
  const pointUnit = target.item ? 'timelineFrame' : 'sourceMs';
  return {
    assetId: target.asset.id,
    ...(target.item ? { itemId: target.item.id } : {}),
    analysisRef: musicAnalysisRef(analysis),
    bpm: Number(analysis.bpm.toFixed(2)),
    meter: analysis.meter,
    confidence: Number(analysis.beatConfidence.toFixed(3)),
    durationMs: analysis.durationMs,
    range,
    pointUnit,
    beatCount: beatPoints.length,
    downbeatCount: downbeatPoints.length,
    beats: inspectPointList(analysis.beatsMs, target.item, ctx.getState().fps, range, MAX_INSPECT_BEATS),
    downbeats: inspectPointList(analysis.downbeatsMs, target.item, ctx.getState().fps, range, MAX_INSPECT_DOWNBEATS),
    sections: listedSections(analysis, range),
    sectionCount: analysis.sections.filter((section) => section.toMs > range.fromMs && section.fromMs < range.toMs).length,
    tags: roundedTags(analysis),
    truncated: beatPoints.length > MAX_INSPECT_BEATS
      || downbeatPoints.length > MAX_INSPECT_DOWNBEATS
      || analysis.sections.length > MAX_INSPECT_SECTIONS
      || analysis.tags.length > MAX_INSPECT_TAGS,
  };
}

export async function analyzeMusic(args: Args, ctx: AgentContext): Promise<unknown> {
  const { asset } = resolveMusicTarget(args, ctx);
  const analysis = await enqueueMusicAnalysis(asset, { force: args.force === true });
  return analysis ? await inspectMusic(args, ctx) : await unavailableAnalysis(asset);
}

export function normalizePlanOptions(args: Args): MusicPlanOptions {
  const timing = args.timing;
  const density = args.density;
  if (timing !== 'auto' && timing !== 'beat' && timing !== 'downbeat' && timing !== 'section') {
    throw new Error('timing must be auto, beat, downbeat, or section');
  }
  if (density !== 'sparse' && density !== 'medium' && density !== 'dense') {
    throw new Error('density must be sparse, medium, or dense');
  }
  const targetItemIds = Array.isArray(args.targetItemIds)
    ? args.targetItemIds.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : undefined;
  return {
    timing,
    density,
    fromFrame: finiteNumber(args.fromFrame),
    toFrame: finiteNumber(args.toFrame),
    targetItemIds,
  };
}

export function normalizeImagePlanOptions(args: Args): MusicImagePlanOptions {
  const imageAssetIds = Array.isArray(args.imageAssetIds)
    ? args.imageAssetIds.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : undefined;
  const track = typeof args.track === 'string' && args.track.trim() ? args.track.trim() : undefined;
  return { ...normalizePlanOptions(args), imageAssetIds, track };
}

function planRange(item: TimelineItem, options: MusicPlanOptions): MusicEditPlan['range'] {
  const itemEnd = item.startFrame + item.durationInFrames;
  const fromFrame = Math.max(item.startFrame, Math.round(options.fromFrame ?? item.startFrame));
  const toFrame = Math.min(itemEnd, Math.round(options.toFrame ?? itemEnd));
  if (toFrame <= fromFrame) throw new Error('requested timeline range does not overlap the BGM clip');
  return { fromFrame, toFrame };
}

function sectionPoints(analysis: MusicAnalysis): number[] {
  return [...new Set(analysis.sections.map((section) => section.fromMs))].sort((a, b) => a - b);
}

function timingPoints(analysis: MusicAnalysis, timing: MusicEditPlan['timing']): readonly number[] {
  if (timing === 'beat') return analysis.beatsMs;
  if (timing === 'downbeat') return analysis.downbeatsMs;
  return sectionPoints(analysis);
}

function chooseTiming(
  analysis: MusicAnalysis,
  item: TimelineItem,
  state: TimelineState,
  options: MusicPlanOptions,
  range: MusicEditPlan['range'],
): MusicEditPlan['timing'] {
  if (options.timing !== 'auto') return options.timing;
  const order: MusicEditPlan['timing'][] = options.density === 'sparse'
    ? ['section', 'downbeat', 'beat']
    : options.density === 'medium'
      ? ['downbeat', 'beat', 'section']
      : ['beat', 'downbeat', 'section'];
  return order.find((timing) => mapSourcePoints(timingPoints(analysis, timing), item, state.fps)
    .some((frame) => frame > range.fromFrame && frame < range.toFrame)) ?? order[0];
}

function selectedVideoTargets(
  state: TimelineState,
  options: MusicPlanOptions,
  range: MusicEditPlan['range'],
  musicItemId: string,
): TimelineItem[] {
  const videos = state.items.filter((item) => item.kind === 'video');
  const selected = options.targetItemIds?.length
    ? options.targetItemIds.map((id) => resolvePrefix(videos, id.trim(), 'video clip'))
    : videos;
  const unique = [...new Map(selected.map((item) => [item.id, item])).values()];
  return unique
    .filter((item) => item.id !== musicItemId
      && item.startFrame < range.toFrame
      && item.startFrame + item.durationInFrames > range.fromFrame)
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
}

function frameHitsTarget(frame: number, targets: readonly TimelineItem[]): boolean {
  return targets.some((item) => frame > item.startFrame && frame < item.startFrame + item.durationInFrames);
}

export function buildMusicEditPlan(
  analysis: MusicAnalysis,
  analysisRef: string,
  musicItem: TimelineItem,
  state: TimelineState,
  options: MusicPlanOptions,
): BuiltPlan {
  const range = planRange(musicItem, options);
  const timing = chooseTiming(analysis, musicItem, state, options, range);
  const allTargets = selectedVideoTargets(state, options, range, musicItem.id);
  const targets = allTargets.slice(0, MAX_MUSIC_PLAN_TARGETS);
  const mapped = mapSourcePoints(timingPoints(analysis, timing), musicItem, state.fps)
    .filter((frame) => frame > range.fromFrame && frame < range.toFrame);
  const sampled = mapped.filter((_, index) => index % DENSITY_STRIDE[options.density] === 0);
  const available = sampled.filter((frame) => frameHitsTarget(frame, targets));
  const cutFrames = available.slice(0, MAX_MUSIC_PLAN_CUTS);
  const plannedTargets = targets.filter((item) => cutFrames.some(
    (frame) => frame > item.startFrame && frame < item.startFrame + item.durationInFrames,
  ));
  const targetItemIds = plannedTargets.map((item) => item.id);
  return {
    plan: {
      schemaVersion: 1,
      analysisRef,
      musicItemId: musicItem.id,
      targetItemIds,
      timing,
      range,
      cutFrames,
    },
    availableCutCount: available.length,
    overlappingTargetCount: allTargets.length,
    lockedTargetCount: plannedTargets.filter((item) => state.tracks?.[item.track]?.locked).length,
    targetLimitReached: allTargets.length > targets.length,
  };
}

function selectedImageAssets(
  assets: readonly MediaAsset[],
  options: MusicImagePlanOptions,
): MediaAsset[] {
  const images = assets.filter((asset) => asset.kind === 'image');
  const selected = options.imageAssetIds?.length
    ? options.imageAssetIds.map((id) => resolvePrefix(images, id.trim(), 'image asset'))
    : images;
  return [...new Map(selected.map((asset) => [asset.id, asset])).values()]
    .slice(0, MAX_MUSIC_IMAGE_ASSETS);
}

function imageTrack(state: TimelineState, requested?: string): string {
  if (requested !== undefined) {
    const track = resolveTrackId(state, requested, 'video');
    if (!track) throw new Error(`video track "${requested}" not found; call edit_track action=list`);
    return track;
  }
  const track = resolveTrackId(state, 'V1', 'video') ?? defaultTrackId(state, 'video');
  if (!track) throw new Error('no video track for photo placement — create one with edit_track first');
  return track;
}

export function buildMusicImagePlacementPlan(
  analysis: MusicAnalysis,
  analysisRef: string,
  musicItem: TimelineItem,
  state: TimelineState,
  assets: readonly MediaAsset[],
  options: MusicImagePlanOptions,
): BuiltImagePlan {
  const range = planRange(musicItem, options);
  const images = selectedImageAssets(assets, options);
  if (!images.length) throw new Error('no image assets available for photo placement');
  const timing = chooseTiming(analysis, musicItem, state, options, range);
  const mapped = mapSourcePoints(timingPoints(analysis, timing), musicItem, state.fps)
    .filter((frame) => frame > range.fromFrame && frame < range.toFrame);
  const sampled = mapped.filter((_, index) => index % DENSITY_STRIDE[options.density] === 0);
  const cutFrames = [...new Set(sampled)].slice(0, Math.max(0, MAX_MUSIC_IMAGE_PLACEMENTS - 1));
  const boundaries = [range.fromFrame, ...cutFrames, range.toFrame];
  const placements: MusicImagePlacement[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startFrame = boundaries[index]!;
    const endFrame = boundaries[index + 1]!;
    if (endFrame <= startFrame) continue;
    placements.push({
      assetId: images[index % images.length]!.id,
      startFrame,
      durationInFrames: endFrame - startFrame,
    });
  }
  return {
    plan: {
      schemaVersion: 1,
      analysisRef,
      musicItemId: musicItem.id,
      imageAssetIds: images.map((asset) => asset.id),
      track: imageTrack(state, options.track),
      timing,
      range,
      placements,
    },
    availableCutCount: sampled.length,
    imageCount: images.length,
  };
}
