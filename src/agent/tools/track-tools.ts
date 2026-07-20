import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import { resolveTrackId, timelineTrackIds, trackAlias, trackKind, type TimelineState, type TrackId, type TrackRole, type TrackUpdate } from '../../editor/types';

export const TRACK_TOOL_SCHEMAS: Anthropic.Tool[] = [{
  name: 'edit_track',
  description: 'Manage tracks. Actions: list | create | update | delete | tighten. Tracks have stable ids plus V1/A1 aliases that may renumber after insertion. create accepts json with trackType video/audio, optional count/order/name/role/audioRouting. update changes order/hidden/muted/locked/name/role/audioRouting — locked freezes the lane: clips on a locked track cannot be moved/trimmed/split/deleted/edited and nothing new lands on it. delete removes empty tracks only. tighten closes gaps between clips.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete', 'tighten'] },
      json: { type: 'string', description: 'JSON payload for create/update, e.g. {"trackType":"audio","role":"follower"} or {"hidden":true}.' },
      trackId: { type: 'string', description: 'Current Vn/An alias or stable track id (update/delete/tighten).' },
      trackIds: { type: 'array', items: { type: 'string' }, description: 'delete: remove several empty tracks atomically.' },
    },
    required: ['action'],
  },
}];

export const TRACK_TOOL_NAMES = new Set(TRACK_TOOL_SCHEMAS.map((tool) => tool.name));

type Args = Record<string, unknown>;

function payload(value: unknown): Args | { error: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Args;
  if (typeof value !== 'string') return { error: 'json must be a JSON object string' };
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Args : { error: 'json must decode to an object' };
  } catch (error) {
    return { error: `invalid json: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function describe(state: TimelineState, id: TrackId) {
  const alias = trackAlias(state, id);
  const config = state.tracks?.[id] ?? {};
  return {
    id,
    alias,
    trackType: trackKind(state, id),
    order: Math.max(0, Number(alias.slice(1)) - 1),
    name: config.name ?? null,
    hidden: config.hidden ?? false,
    muted: config.muted ?? false,
    locked: config.locked ?? false,
    role: config.role ?? null,
    audioRouting: config.audioRouting ?? null,
    clips: state.items.filter((item) => item.track === id).length,
  };
}

const list = (state: TimelineState) => timelineTrackIds(state).map((id) => describe(state, id));

async function waitForTracks(ctx: AgentContext, ids: TrackId[]): Promise<TimelineState> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = ctx.getState();
    const known = new Set(timelineTrackIds(state));
    if (ids.every((id) => known.has(id))) return state;
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }
  return ctx.getState();
}

export async function execTrackTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'edit_track') return { error: `unknown tool ${name}` };
  const state = ctx.getState();
  switch (String(args.action)) {
    case 'list':
      return list(state);

    case 'create': {
      const data = payload(args.json);
      if ('error' in data) return data;
      const kind = data.trackType;
      if (kind !== 'video' && kind !== 'audio') return { error: 'create requires json.trackType = video or audio' };
      const count = Math.max(1, Math.min(32, Math.round(Number(data.count) || 1)));
      const role = data.role === 'anchor' || data.role === 'follower' ? data.role as TrackRole : undefined;
      const duckDepthDb = typeof (data.audioRouting as Args | undefined)?.duckDepthDb === 'number'
        ? Math.max(-60, Math.min(0, Number((data.audioRouting as Args).duckDepthDb))) : undefined;
      const created: TrackId[] = [];
      for (let index = 0; index < count; index++) {
        created.push(ctx.commands.createTrack(kind, {
          name: typeof data.name === 'string' ? data.name : undefined,
          role,
          order: typeof data.order === 'number' ? Math.round(data.order) + index : undefined,
          audioRouting: duckDepthDb === undefined ? undefined : { duckDepthDb },
        }));
      }
      const after = await waitForTracks(ctx, created);
      return { ok: true, created: created.map((id) => describe(after, id)), tracks: list(after) };
    }

    case 'update': {
      const id = resolveTrackId(state, args.trackId);
      if (!id) return { error: `no track ${args.trackId}`, tracks: list(state) };
      const data = payload(args.json);
      if ('error' in data) return data;
      const patch: TrackUpdate = {};
      if (typeof data.order === 'number') patch.order = Math.round(data.order);
      if (typeof data.hidden === 'boolean') patch.hidden = data.hidden;
      if (typeof data.muted === 'boolean') patch.muted = data.muted;
      if (typeof data.locked === 'boolean') patch.locked = data.locked;
      if (typeof data.name === 'string') patch.name = data.name.trim();
      if (data.role === null || data.role === 'anchor' || data.role === 'follower') patch.role = data.role as TrackRole | null;
      const routing = data.audioRouting as Args | undefined;
      if (routing && (routing.duckDepthDb === null || typeof routing.duckDepthDb === 'number')) {
        patch.audioRouting = { duckDepthDb: routing.duckDepthDb === null ? null : Math.max(-60, Math.min(0, Number(routing.duckDepthDb))) };
      }
      if (!Object.keys(patch).length) return { error: 'update json must include order, hidden, muted, locked, name, role, or audioRouting' };
      ctx.commands.updateTrack(id, patch);
      const after = ctx.getState();
      return { ok: true, track: describe(after, id), tracks: list(after) };
    }

    case 'delete': {
      const refs = Array.isArray(args.trackIds) && args.trackIds.length ? args.trackIds : [args.trackId];
      const ids = refs.map((ref) => resolveTrackId(state, ref));
      if (ids.some((id) => !id)) return { error: 'one or more tracks do not exist', tracks: list(state) };
      const unique = [...new Set(ids as TrackId[])];
      const busy = unique.filter((id) => state.items.some((item) => item.track === id)
        || (state.transitions ?? []).some((transition) => transition.trackId === id));
      if (busy.length) return { error: 'track is not empty', tracks: busy.map((id) => describe(state, id)) };
      ctx.commands.deleteTracks(unique);
      return { ok: true, deleted: unique, tracks: list(ctx.getState()) };
    }

    case 'tighten': {
      const id = resolveTrackId(state, args.trackId);
      if (!id) return { error: `no track ${args.trackId}`, tracks: list(state) };
      if (state.tracks?.[id]?.locked) return { error: 'track is locked' };
      ctx.commands.tightenTrack(id);
      return { ok: true, track: describe(ctx.getState(), id) };
    }

    default:
      return { error: `unknown action ${args.action}; use list/create/update/delete/tighten` };
  }
}
