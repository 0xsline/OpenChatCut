export { READ_PROJECT_TOOL_SCHEMAS, READ_PROJECT_TOOL_NAMES } from './schemas/read-project-tools';
import type { AgentContext } from '../context';
import {
  captionTrackEntries,
  captionsOnTrack,
  resolveTrackId,
  timelineTrackIds,
  trackAlias,
  trackKind,
  type Timeline,
  type TimelineItem,
  type MediaAsset,
  type TimelineState,
} from '../../editor/types';
import { hasOperationalTranscript } from '../../transcript/types';
import { resolveTimeline } from './timeline-target';

// read_project returns one overview of project state, including timeline and assets.
// Aggregates existing store/doc fields; no separate backend.

type Args = Record<string, unknown>;

function splitIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function slimItem(
  it: TimelineItem,
  state: TimelineState,
  assets: readonly MediaAsset[],
  offlineSrcs: ReadonlySet<string>,
) {
  const sourceAssetId = it.src ? assets.find((asset) => asset.src === it.src)?.id ?? null : null;
  const denoisedAssetId = it.denoisedSrc
    ? assets.find((asset) => asset.src === it.denoisedSrc && asset.kind === 'audio')?.id ?? null
    : null;
  return {
    id: it.id,
    trackId: it.track,
    track: trackAlias(state, it.track),
    name: it.name,
    kind: it.kind,
    startFrame: it.startFrame,
    durationInFrames: it.durationInFrames,
    src: it.src ?? null,
    offline: !!it.src && offlineSrcs.has(it.src),
    templateId: it.templateId ?? null,
    volume: it.volume ?? null,
    zoom: it.zoom ?? null,
    backgroundFill: it.backgroundFill === true,
    effects: (it.effects ?? []).map((e) => ({
      effectId: e.id,
      assetId: e.assetId,
      overrides: e.overrides ?? {},
    })),
    props: it.props ?? null,
    hasTranscript: hasOperationalTranscript(it),
    transcriptStale: it.transcriptStale === true,
    sourceAssetId,
    voiceIsolation: it.denoisedSrc
      ? { denoisedAssetId, strength: it.denoiseStrength ?? null }
      : null,
  };
}

/**
 * Gaps between clips on a track [fromFrame, toFrame). The hole on the main video track is exported as a black frame and is not active.
 * The reported model has to be discovered by subtracting it segment by segment. Blank spaces at the beginning and end don't count - it's just that the track hasn't started/has started
 * The end can be seen from the frame number of the clip itself. Overlapping fragments are treated with scrolling maximum right edge.
 * exported for verify.
 */
export function trackGaps(
  items: readonly TimelineItem[],
  track: string,
): { fromFrame: number; toFrame: number }[] {
  const sorted = items.filter((it) => it.track === track).toSorted((a, b) => a.startFrame - b.startFrame);
  const first = sorted[0];
  if (!first) return [];
  const gaps: { fromFrame: number; toFrame: number }[] = [];
  let end = first.startFrame;
  for (const it of sorted) {
    if (it.startFrame > end) gaps.push({ fromFrame: end, toFrame: it.startFrame });
    end = Math.max(end, it.startFrame + it.durationInFrames);
  }
  return gaps;
}

function itemsOverlap(it: TimelineItem, from?: number, to?: number): boolean {
  const start = it.startFrame;
  const end = it.startFrame + it.durationInFrames;
  if (from != null && end <= from) return false;
  if (to != null && start >= to) return false;
  return true;
}

export async function execReadProjectTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'read_project') return { error: `unknown tool ${name}` };

  let timeline: Timeline;
  try {
    timeline = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  const view = args.view === 'timeline' || args.view === 'assets' ? args.view : 'full';
  const fromFrame = typeof args.fromFrame === 'number' ? args.fromFrame : undefined;
  const toFrame = typeof args.toFrame === 'number' ? args.toFrame : undefined;
  const trackFilter = typeof args.track === 'string' ? args.track.trim() : '';
  const itemIds = splitIds(args.itemId);
  const assetIds = splitIds(args.assetId);
  const includeCode = args.code === true;
  const doc = ctx.getDoc();
  const state = timeline as TimelineState;
  const offlineSrcs = ctx.getOfflineMediaSrcs?.() ?? new Set<string>();

  let trackIdFilter: string | null = null;
  if (trackFilter) {
    trackIdFilter = resolveTrackId(state, trackFilter) ?? null;
    if (!trackIdFilter) {
      // also match alias loosely
      const ids = timelineTrackIds(state);
      trackIdFilter = ids.find((id) => trackAlias(state, id) === trackFilter || id === trackFilter) ?? null;
      if (!trackIdFilter) return { error: `track not found: ${trackFilter}` };
    }
  }

  const out: Record<string, unknown> = {
    ok: true,
    projectId: ctx.getProjectId?.() ?? null,
    activeTimelineId: doc.activeTimelineId,
    timelines: doc.timelines.map((t) => ({
      id: t.id,
      name: t.name,
      order: t.order,
      active: t.id === doc.activeTimelineId,
      fps: t.fps,
      width: t.width,
      height: t.height,
      itemCount: t.items.length,
    })),
  };

  if (view === 'full' || view === 'timeline') {
    const captionTracks = captionTrackEntries(state);
    const captionTrack = captionTracks[0]?.id ?? null;
    let items = state.items.slice();
    if (trackIdFilter) items = items.filter((it) => it.track === trackIdFilter);
    if (fromFrame != null || toFrame != null) {
      items = items.filter((it) => itemsOverlap(it, fromFrame, toFrame));
    }
    if (itemIds.length) {
      items = items.filter((it) =>
        itemIds.some((q) => it.id === q || it.id.startsWith(q)),
      );
    }

    out.timeline = {
      id: timeline.id,
      name: timeline.name,
      fps: state.fps,
      width: state.width,
      height: state.height,
      fit: state.fit ?? 'contain',
      tracks: timelineTrackIds(state).map((id) => {
        // The gaps are calculated based on the entire track (not affected by from/to, itemId filtering), otherwise the holes reported are false.
        const gaps = trackKind(state, id) === 'caption' ? [] : trackGaps(state.items, id);
        return {
          id,
          alias: trackAlias(state, id),
          trackType: trackKind(state, id),
          name: state.tracks?.[id]?.name,
          locked: state.tracks?.[id]?.locked ?? false,
          hidden: trackKind(state, id) === 'caption' ? !captionsOnTrack(state, id)?.enabled : state.tracks?.[id]?.hidden ?? false,
          ...(gaps.length ? { gaps } : {}),
        };
      }),
      items: items.map((it) => slimItem(it, state, doc.assets, offlineSrcs)),
      transitions: (state.transitions ?? []).map((t) => ({
        id: t.id,
        type: t.type,
        assetId: `builtin:tr-${t.type}`,
        durationInFrames: t.durationInFrames,
        outgoingItemId: t.outgoingItemId,
        incomingItemId: t.incomingItemId,
        trackId: t.trackId,
      })),
      markers: (state.markers ?? []).map((m) => ({
        id: m.id,
        scope: m.scope,
        itemId: m.itemId ?? null,
        fromFrame: m.fromFrame,
        durationFrames: m.durationFrames,
        note: m.note,
        color: m.color,
      })),
      captions: state.captions
        ? {
            enabled: state.captions.enabled,
            template: state.captions.template,
            trackId: captionTrack,
            trackAlias: captionTrack ? trackAlias(state, captionTrack) : null,
            sourceItemId: state.captions.sourceItemId ?? null,
            bilingual: state.captions.bilingual ?? false,
          }
        : null,
      captionTracks: captionTracks.map((entry) => ({
        id: entry.id,
        alias: trackAlias(state, entry.id),
        name: state.tracks?.[entry.id]?.name ?? null,
        enabled: entry.captions?.enabled ?? false,
        template: entry.captions?.template ?? null,
        sourceItemId: entry.captions?.sourceItemId ?? null,
        bilingual: entry.captions?.bilingual ?? false,
      })),
    };
  }

  if (view === 'full' || view === 'assets') {
    let assets = doc.assets.slice();
    if (assetIds.length) {
      assets = assets.filter((a) =>
        assetIds.some((q) => a.id === q || a.id.startsWith(q)),
      );
    }
    out.mediaPool = {
      folders: (doc.mediaFolders ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId ?? null,
      })),
      assets: assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        src: a.src || null,
        offline: !!a.src && offlineSrcs.has(a.src),
        durationInFrames: a.durationInFrames,
        width: a.width ?? null,
        height: a.height ?? null,
        folderId: a.folderId ?? null,
        favorite: a.favorite ?? false,
        ...(includeCode && assetIds.length && a.code ? { code: a.code } : {}),
      })),
      assetCount: doc.assets.length,
      offlineAssetCount: doc.assets.filter((asset) => offlineSrcs.has(asset.src)).length,
    };
    if (doc.designStyle) {
      out.designStyle = {
        colorCount: doc.designStyle.colors?.length ?? 0,
        fontCount: doc.designStyle.fonts?.length ?? 0,
        hasStyleGuide: !!doc.designStyle.styleGuide,
      };
    }
  }

  return out;
}
