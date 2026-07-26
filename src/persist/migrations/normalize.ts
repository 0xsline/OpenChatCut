import { t } from '../../i18n/locale';
import {
  timelineTrackIds,
  trackKind,
  type DesignStyle,
  type MediaAsset,
  type MediaFolder,
  type Timeline,
  type TimelineItem,
  type TimelineState,
} from '../../editor/types';

export type LooseProjectShape = {
  version?: unknown;
  assets?: unknown;
  mediaFolders?: unknown;
  timelines: Timeline[];
  activeTimelineId: string;
  designStyle?: unknown;
};

const ITEM_KINDS = new Set<TimelineItem['kind']>([
  'motion-graphic', 'audio', 'video', 'image', 'text', 'gif', 'svg', 'solid',
]);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalFinite = (value: unknown): boolean => value === undefined || finite(value);

export function isTimelineItem(value: unknown): value is TimelineItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TimelineItem>;
  return typeof item.id === 'string' && !!item.id
    && typeof item.track === 'string' && !!item.track
    && typeof item.name === 'string'
    && typeof item.kind === 'string' && ITEM_KINDS.has(item.kind as TimelineItem['kind'])
    && finite(item.startFrame) && Number.isInteger(item.startFrame) && item.startFrame >= 0
    && finite(item.durationInFrames) && Number.isInteger(item.durationInFrames) && item.durationInFrames > 0
    && optionalFinite(item.srcInFrame) && (item.srcInFrame === undefined || item.srcInFrame >= 0)
    && optionalFinite(item.playbackRate) && (item.playbackRate === undefined || item.playbackRate > 0)
    && optionalFinite(item.volume) && (item.volume === undefined || (item.volume >= 0 && item.volume <= 2));
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

export function dedupeAssets(values: readonly unknown[]): MediaAsset[] {
  const unique = new Map<string, MediaAsset>();
  for (const value of values) {
    if (isMediaAsset(value) && !unique.has(value.id)) unique.set(value.id, value);
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

/** V3 uses stable track ids instead of display aliases such as V1/A1. */
export function normalizeTimelineTracks(timeline: Timeline): Timeline {
  const clean = stripTimelineAssets(timeline);
  const ids = timelineTrackIds(clean);
  const alreadyStable = !!clean.trackOrder?.length
    && !ids.some((id) => /^[CVA]\d+$/i.test(id))
    && ids.every((id) => ['video', 'audio', 'caption'].includes(clean.tracks?.[id]?.kind ?? ''));
  if (alreadyStable) return withCaptionTrack(clean);
  const remap = new Map(ids.map((id, index) => [id, `track_${clean.id}_${index + 1}`]));
  const trackOrder = ids.map((id) => remap.get(id)!);
  const tracks = Object.fromEntries(ids.map((id) => {
    const nextId = remap.get(id)!;
    return [nextId, { ...clean.tracks?.[id], kind: trackKind(clean, id) }];
  }));
  return withCaptionTrack({
    ...clean,
    trackOrder,
    tracks,
    items: clean.items.map((item) => ({ ...item, track: remap.get(item.track) ?? item.track })),
    transitions: clean.transitions?.map((transition) => ({
      ...transition,
      trackId: remap.get(transition.trackId) ?? transition.trackId,
    })),
  });
}

/** Pre-versioned single timelines become deterministic V1 project documents. */
export function timelineToV1(value: TimelineState): LooseProjectShape & { version: 1 } {
  const raw = value as TimelineState & Partial<Pick<Timeline, 'id' | 'name' | 'order'>>;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : 'tl_legacy_1';
  const timeline: Timeline = {
    ...raw,
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : t('序列 1'),
    order: typeof raw.order === 'number' ? raw.order : 0,
  };
  return { version: 1, timelines: [timeline], activeTimelineId: id };
}
