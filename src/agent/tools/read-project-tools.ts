import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import {
  resolveTrackId,
  timelineTrackIds,
  trackAlias,
  trackKind,
  type Timeline,
  type TimelineItem,
  type MediaAsset,
  type TimelineState,
} from '../../editor/types';
import { resolveTimeline } from './timeline-target';

// read_project returns one overview of project state, including timeline and assets.
// Aggregates existing store/doc fields; no separate backend.

type Args = Record<string, unknown>;

export const READ_PROJECT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_project',
    description: [
      'View the project — tracks, timeline items, markers, media-pool folders, and assets.',
      'Default = full overview. Narrow with view:"timeline"|"assets", timelineId, track, fromFrame/toFrame, itemId, assetId.',
      'Pass code:true with assetId to include MG source code.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['timeline', 'assets'],
          description: "'timeline' tracks+items+markers; 'assets' library only. Omit for full overview.",
        },
        timelineId: { type: 'string', description: 'Inspect a non-active timeline by id/prefix without switching.' },
        track: { type: 'string', description: 'Filter by track alias (e.g. V1, A1).' },
        fromFrame: { type: 'number', description: 'Items overlapping this frame or later (half-open with toFrame).' },
        toFrame: { type: 'number', description: 'Exclusive upper frame bound.' },
        itemId: { type: 'string', description: 'Item id(s) or prefixes, comma-separated.' },
        assetId: { type: 'string', description: 'Asset id(s) or prefixes, comma-separated.' },
        code: { type: 'boolean', description: 'Include MG code when assetId is set.' },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
    },
  },
];

export const READ_PROJECT_TOOL_NAMES = new Set(READ_PROJECT_TOOL_SCHEMAS.map((t) => t.name));

function splitIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function slimItem(it: TimelineItem, state: TimelineState, assets: readonly MediaAsset[]) {
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
    templateId: it.templateId ?? null,
    volume: it.volume ?? null,
    zoom: it.zoom ?? null,
    effects: (it.effects ?? []).map((e) => ({
      effectId: e.id,
      assetId: e.assetId,
      overrides: e.overrides ?? {},
    })),
    props: it.props ?? null,
    hasTranscript: Array.isArray(it.transcript) && it.transcript.length > 0,
    sourceAssetId,
    voiceIsolation: it.denoisedSrc
      ? { denoisedAssetId, strength: it.denoiseStrength ?? null }
      : null,
  };
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
      tracks: timelineTrackIds(state).map((id) => ({
        id,
        alias: trackAlias(state, id),
        trackType: trackKind(state, id),
        name: state.tracks?.[id]?.name,
        locked: state.tracks?.[id]?.locked ?? false,
        hidden: state.tracks?.[id]?.hidden ?? false,
      })),
      items: items.map((it) => slimItem(it, state, doc.assets)),
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
            sourceItemId: state.captions.sourceItemId ?? null,
            bilingual: state.captions.bilingual ?? false,
          }
        : null,
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
        durationInFrames: a.durationInFrames,
        width: a.width ?? null,
        height: a.height ?? null,
        folderId: a.folderId ?? null,
        favorite: a.favorite ?? false,
        ...(includeCode && assetIds.length && a.code ? { code: a.code } : {}),
      })),
      assetCount: doc.assets.length,
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
