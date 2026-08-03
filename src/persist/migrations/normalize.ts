import {
  timelineTrackIds,
  trackKind,
  type DesignStyle,
  type MediaAsset,
  type MediaFolder,
  type MulticamAngle,
  type MulticamGroup,
  type MulticamSyncEvidence,
  type Timeline,
  type TimelineItem,
  type TimelineLinkGroup,
  type TimelineState,
} from '../../editor/types.js';
import { isSourceClockMetadata } from '../../editor/timecode.js';
import { withMediaSourceRevision } from '../../editor/mediaSourceRevision.js';
import { safeSourceFilename } from '../../media/sourceFilename.js';

export type LooseProjectShape = {
  version?: unknown;
  assets?: unknown;
  mediaFolders?: unknown;
  timelines: Timeline[];
  activeTimelineId: string;
  designStyle?: unknown;
};

const ITEM_KINDS: Record<TimelineItem['kind'], true> = {
  'motion-graphic': true,
  audio: true,
  video: true,
  image: true,
  text: true,
  gif: true,
  svg: true,
  solid: true,
  sequence: true,
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalFinite = (value: unknown): boolean => value === undefined || finite(value);
function normalizeSourceFilename<T extends { readonly sourceFilename?: string }>(value: T): T {
  if (!Object.hasOwn(value, 'sourceFilename')) return value;
  const sourceFilename: unknown = Reflect.get(value, 'sourceFilename');
  const safeFilename = safeSourceFilename(sourceFilename);
  if (safeFilename === sourceFilename) return value;
  const { sourceFilename: _sourceFilename, ...rest } = value;
  return (safeFilename === undefined ? rest : { ...rest, sourceFilename: safeFilename }) as T;
}

function normalizeTimelineSourceFilenames(timeline: Timeline): Timeline {
  const items = timeline.items.map(normalizeSourceFilename);
  const multicamGroups = timeline.multicamGroups?.map((group) => ({
    ...group,
    angles: group.angles.map((angle) => ({
      ...angle,
      source: normalizeSourceFilename(angle.source),
    })),
  }));
  return {
    ...timeline,
    items,
    ...(timeline.multicamGroups === undefined ? {} : { multicamGroups }),
  };
}


export function isTimelineItem(value: unknown): value is TimelineItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TimelineItem>;
  return typeof item.id === 'string' && !!item.id
    && typeof item.track === 'string' && !!item.track
    && typeof item.name === 'string'
    && typeof item.kind === 'string' && ITEM_KINDS[item.kind as TimelineItem['kind']] === true
    && finite(item.startFrame) && Number.isInteger(item.startFrame) && item.startFrame >= 0
    && finite(item.durationInFrames) && Number.isInteger(item.durationInFrames) && item.durationInFrames > 0
    && optionalFinite(item.srcInFrame) && (item.srcInFrame === undefined || item.srcInFrame >= 0)
    && optionalFinite(item.playbackRate) && (item.playbackRate === undefined || item.playbackRate > 0)
    && optionalFinite(item.volume) && (item.volume === undefined || (item.volume >= 0 && item.volume <= 2))
    && (item.sourceAssetId === undefined || typeof item.sourceAssetId === 'string')
    && (item.kind !== 'sequence' || (typeof item.timelineId === 'string' && item.timelineId.length > 0));
}

export function isTimelineState(value: unknown): value is TimelineState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<TimelineState>;
  return Array.isArray(state.items) && state.items.every(isTimelineItem)
    && finite(state.fps) && state.fps > 0;
}

export function isProjectShape(value: unknown): value is LooseProjectShape {
  return !!value && typeof value === 'object'
    && Array.isArray((value as { timelines?: unknown }).timelines)
    && (value as { timelines: unknown[] }).timelines.length > 0
    && (value as { timelines: unknown[] }).timelines.every(isTimelineState)
    && typeof (value as { activeTimelineId?: unknown }).activeTimelineId === 'string';
}

export function isDesignStyle(value: unknown): value is DesignStyle {
  if (!value || typeof value !== 'object') return false;
  const style = value as { colors?: unknown; fonts?: unknown };
  return Array.isArray(style.colors) && Array.isArray(style.fonts);
}

export function isMediaAsset(value: unknown): value is MediaAsset {
  if (!value || typeof value !== 'object') return false;
  const asset = value as Partial<MediaAsset>;
  return typeof asset.id === 'string'
    && typeof asset.name === 'string'
    && (asset.kind === 'video' || asset.kind === 'image' || asset.kind === 'audio' || asset.kind === 'motion-graphic')
    && typeof asset.src === 'string'
    && finite(asset.durationInFrames) && asset.durationInFrames > 0
    && (asset.kind !== 'motion-graphic' || typeof asset.code === 'string');
}

function normalizeAssetClocks(asset: MediaAsset): MediaAsset {
  const sourceTimecode = isSourceClockMetadata(asset.sourceTimecode) ? asset.sourceTimecode : undefined;
  const captureClock = isSourceClockMetadata(asset.captureClock) ? asset.captureClock : undefined;
  if (sourceTimecode === asset.sourceTimecode && captureClock === asset.captureClock) return asset;
  const { sourceTimecode: _sourceTimecode, captureClock: _captureClock, ...rest } = asset;
  return {
    ...rest,
    ...(sourceTimecode ? { sourceTimecode } : {}),
    ...(captureClock ? { captureClock } : {}),
  };
}

export function dedupeAssets(values: readonly unknown[]): MediaAsset[] {
  const unique = new Map<string, MediaAsset>();
  for (const value of values) {
    if (isMediaAsset(value) && !unique.has(value.id)) {
      unique.set(value.id, withMediaSourceRevision(normalizeSourceFilename(normalizeAssetClocks(value))));
    }
  }
  return [...unique.values()];
}

export function isMediaFolder(value: unknown): value is MediaFolder {
  if (!value || typeof value !== 'object') return false;
  const folder = value as Partial<MediaFolder>;
  return typeof folder.id === 'string' && typeof folder.name === 'string'
    && (folder.parentId === undefined || typeof folder.parentId === 'string');
}

export function normalizeFolders(value: unknown): MediaFolder[] {
  const folders = Array.isArray(value) ? value.filter(isMediaFolder) : [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  return folders.map((folder) => folder.parentId && (!folderIds.has(folder.parentId) || folder.parentId === folder.id)
    ? { ...folder, parentId: undefined }
    : folder);
}

export function stripTimelineAssets(timeline: Timeline): Timeline {
  const { assets: _legacyAssets, ...rest } = timeline;
  return rest;
}

function withCaptionTrack(timeline: Timeline): Timeline {
  const existingId = timelineTrackIds(timeline).find((id) => trackKind(timeline, id) === 'caption');
  if (existingId) {
    const config = timeline.tracks?.[existingId];
    const { name, ...rest } = config ?? {};
    const nextConfig = {
      ...rest,
      ...(name && name !== '字幕' ? { name } : {}),
      ...(config?.captions === undefined && timeline.captions ? { captions: timeline.captions } : {}),
    };
    if (config?.name !== '字幕' && config?.captions !== undefined) return timeline;
    return { ...timeline, tracks: { ...timeline.tracks, [existingId]: nextConfig } };
  }
  if (!timeline.captions) return timeline;
  const baseId = `track_${timeline.id}_captions`;
  const id = timelineTrackIds(timeline).includes(baseId) ? `${baseId}_1` : baseId;
  return {
    ...timeline,
    trackOrder: [id, ...timelineTrackIds(timeline)],
    tracks: { ...timeline.tracks, [id]: { kind: 'caption', captions: timeline.captions } },
  };
}

function isLinkGroup(value: unknown, itemIds: ReadonlySet<string>): value is TimelineLinkGroup {
  if (!value || typeof value !== 'object') return false;
  const group = value as Partial<TimelineLinkGroup>;
  return typeof group.id === 'string' && !!group.id
    && (group.mode === 'linked' || group.mode === 'sync-lock')
    && Array.isArray(group.itemIds)
    && group.itemIds.length >= 2
    && new Set(group.itemIds).size === group.itemIds.length
    && group.itemIds.every((id) => typeof id === 'string' && itemIds.has(id))
    && typeof group.anchorItemId === 'string'
    && group.itemIds.includes(group.anchorItemId);
}

function isMulticamEvidence(value: unknown, angleIds: ReadonlySet<string>): value is MulticamSyncEvidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Partial<MulticamSyncEvidence>;
  return typeof evidence.angleId === 'string' && angleIds.has(evidence.angleId)
    && (evidence.method === 'source-timecode' || evidence.method === 'capture-clock' || evidence.method === 'audio')
    && finite(evidence.confidence) && evidence.confidence >= 0 && evidence.confidence <= 1
    && finite(evidence.offsetFrames);
}

function isMulticamAngle(value: unknown): value is MulticamAngle {
  if (!value || typeof value !== 'object') return false;
  const angle = value as Partial<MulticamAngle>;
  return typeof angle.id === 'string' && !!angle.id
    && typeof angle.itemId === 'string' && !!angle.itemId
    && typeof angle.label === 'string'
    && (angle.micRole === undefined
      || angle.micRole === 'program' || angle.micRole === 'reference'
      || angle.micRole === 'camera' || angle.micRole === 'scratch' || angle.micRole === 'none')
    && finite(angle.offsetFrames)
    && finite(angle.confidence) && angle.confidence >= 0 && angle.confidence <= 1
    && isTimelineItem(angle.source)
    && (angle.source.kind === 'video' || angle.source.kind === 'audio');
}

function normalizeMulticamGroup(value: unknown): MulticamGroup | null {
  if (!value || typeof value !== 'object') return null;
  const group = value as Partial<MulticamGroup>;
  if (typeof group.id !== 'string' || !group.id || !Array.isArray(group.angles)) return null;
  const angles = group.angles.filter(isMulticamAngle);
  if (angles.length < 2) return null;
  const angleIds = new Set(angles.map((angle) => angle.id));
  if (angleIds.size !== angles.length
    || typeof group.referenceAngleId !== 'string' || !angleIds.has(group.referenceAngleId)
    || typeof group.masterAngleId !== 'string' || !angleIds.has(group.masterAngleId)
    || (group.syncMethod !== 'source-timecode' && group.syncMethod !== 'capture-clock' && group.syncMethod !== 'audio')) {
    return null;
  }
  const evidence = Array.isArray(group.evidence) ? group.evidence.filter((entry) => isMulticamEvidence(entry, angleIds)) : [];
  if (angles.some((angle) => !evidence.some((entry) => entry.angleId === angle.id))) return null;
  const decisions = Array.isArray(group.decisions)
    ? group.decisions.filter((decision) => !!decision && typeof decision === 'object'
      && typeof decision.id === 'string'
      && Number.isInteger(decision.fromFrame) && decision.fromFrame >= 0
      && Number.isInteger(decision.toFrame) && decision.toFrame > decision.fromFrame
      && typeof decision.angleId === 'string' && angleIds.has(decision.angleId))
    : undefined;
  return {
    ...group,
    angles,
    evidence,
    ...(decisions?.length ? { decisions } : { decisions: undefined }),
  } as MulticamGroup;
}

/** Drop corrupt/dangling optional professional metadata without changing legacy timelines. */
export function normalizeTimelineGroups(timeline: Timeline): Timeline {
  if (timeline.linkGroups === undefined && timeline.multicamGroups === undefined) return timeline;
  const itemIds = new Set(timeline.items.map((item) => item.id));
  const linkGroups = Array.isArray(timeline.linkGroups)
    ? timeline.linkGroups.filter((group) => isLinkGroup(group, itemIds))
    : undefined;
  const multicamGroups = Array.isArray(timeline.multicamGroups)
    ? timeline.multicamGroups.map(normalizeMulticamGroup).filter((group): group is MulticamGroup => !!group)
    : undefined;
  const memberships = new Map((multicamGroups ?? []).flatMap((group) =>
    group.angles.map((angle) => [angle.itemId, { groupId: group.id, angleId: angle.id }] as const)));
  const items = memberships.size
    ? timeline.items.map((item) => {
        const membership = memberships.get(item.id);
        return membership
          ? { ...item, multicamGroupId: membership.groupId, multicamAngleId: membership.angleId }
          : item;
      })
    : timeline.items;
  return {
    ...timeline,
    items,
    ...(timeline.linkGroups === undefined && linkGroups === undefined ? {} : { linkGroups: linkGroups?.length ? linkGroups : undefined }),
    ...(timeline.multicamGroups === undefined && multicamGroups === undefined ? {} : { multicamGroups: multicamGroups?.length ? multicamGroups : undefined }),
  };
}

/** V3 uses stable track ids instead of display aliases such as V1/A1. */
export function normalizeTimelineTracks(timeline: Timeline): Timeline {
  const clean = stripTimelineAssets(normalizeTimelineSourceFilenames(timeline));
  const ids = timelineTrackIds(clean);
  const alreadyStable = !!clean.trackOrder?.length
    && !ids.some((id) => /^[CVA]\d+$/i.test(id))
    && ids.every((id) => ['video', 'audio', 'caption'].includes(clean.tracks?.[id]?.kind ?? ''));
  if (alreadyStable) return normalizeTimelineGroups(withCaptionTrack(clean));
  const remap = new Map(ids.map((id, index) => [id, `track_${clean.id}_${index + 1}`]));
  const trackOrder = ids.map((id) => remap.get(id)!);
  const tracks = Object.fromEntries(ids.map((id) => {
    const nextId = remap.get(id)!;
    return [nextId, { ...clean.tracks?.[id], kind: trackKind(clean, id) }];
  }));
  return normalizeTimelineGroups(withCaptionTrack({
    ...clean,
    trackOrder,
    tracks,
    items: clean.items.map((item) => ({ ...item, track: remap.get(item.track) ?? item.track })),
    transitions: clean.transitions?.map((transition) => ({
      ...transition,
      trackId: remap.get(transition.trackId) ?? transition.trackId,
    })),
    ...(clean.multicamGroups === undefined ? {} : {
      multicamGroups: clean.multicamGroups.map((group) => ({
        ...group,
        angles: group.angles.map((angle) => ({
          ...angle,
          source: { ...angle.source, track: remap.get(angle.source.track) ?? angle.source.track },
        })),
      })),
    }),
  }));
}

/** Pre-versioned single timelines become deterministic V1 project documents. */
export function timelineToV1(value: TimelineState): LooseProjectShape & { version: 1 } {
  const raw = value as TimelineState & Partial<Pick<Timeline, 'id' | 'name' | 'order'>>;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : 'tl_legacy_1';
  const timeline: Timeline = {
    ...raw,
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '序列 1',
    order: typeof raw.order === 'number' ? raw.order : 0,
  };
  return { version: 1, timelines: [timeline], activeTimelineId: id };
}
