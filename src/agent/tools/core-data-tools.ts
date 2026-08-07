import type { AgentContext } from '../context';
import {
  ASPECT_PRESETS,
  resolveTrackId,
  timelineTrackIds,
  trackAlias,
  trackKind,
  type AspectFit,
} from '../../editor/types';

type Args = Record<string, unknown>;

export const CORE_DATA_TOOL_NAMES = new Set([
  'read_timeline',
  'update_item_props',
  'move_item',
  'set_item_timing',
  'duplicate_item',
  'remove_item',
  'split_item',
  'clear_timeline',
  'set_aspect_ratio',
]);

function findItem(ctx: AgentContext, itemId: unknown) {
  const id = String(itemId ?? '');
  return ctx.getState().items.find((item) => item.id === id || item.id.startsWith(id)) ?? null;
}

function readTimeline(ctx: AgentContext): unknown {
  const state = ctx.getState();
  return {
    fps: state.fps,
    tracks: timelineTrackIds(state).map((id) => ({
      id,
      alias: trackAlias(state, id),
      trackType: trackKind(state, id),
    })),
    items: state.items.map((item) => ({
      id: item.id,
      trackId: item.track,
      track: trackAlias(state, item.track),
      name: item.name,
      startFrame: item.startFrame,
      durationInFrames: item.durationInFrames,
      props: item.props,
      zoom: item.zoom ?? null,
      effects: (item.effects ?? []).map((effect) => ({
        effectId: effect.id,
        assetId: effect.assetId,
        overrides: effect.overrides ?? {},
      })),
    })),
    transitions: (state.transitions ?? []).map((transition) => ({
      id: transition.id,
      type: transition.type,
      assetId: `builtin:tr-${transition.type}`,
      durationInFrames: transition.durationInFrames,
      outgoingItemId: transition.outgoingItemId,
      incomingItemId: transition.incomingItemId,
      trackId: transition.trackId,
    })),
  };
}

function setItemTiming(args: Args, ctx: AgentContext): unknown {
  const item = findItem(ctx, args.itemId);
  if (!item) return { error: `no item ${args.itemId}` };
  if (args.startFrame !== undefined || args.durationInFrames !== undefined) {
    ctx.commands.setItemTiming(item.id, {
      startFrame: args.startFrame as number,
      durationInFrames: args.durationInFrames as number,
      ripple: args.ripple === true,
    });
  }
  const fps = ctx.getState().fps;
  const toFrames = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value * fps))
    : undefined;
  const fadeInFrames = toFrames(args.fadeInSeconds);
  const fadeOutFrames = toFrames(args.fadeOutSeconds);
  if (fadeInFrames !== undefined || fadeOutFrames !== undefined) {
    ctx.commands.setItemFade(item.id, { fadeInFrames, fadeOutFrames });
  }
  return {
    ok: true,
    itemId: item.id,
    ripple: args.ripple === true,
    ...(fadeInFrames !== undefined ? { fadeInFrames } : {}),
    ...(fadeOutFrames !== undefined ? { fadeOutFrames } : {}),
  };
}

function mutateItem(name: string, args: Args, ctx: AgentContext): unknown {
  if (name === 'set_item_timing') return setItemTiming(args, ctx);
  const item = findItem(ctx, args.itemId);
  if (!item) return { error: `no item ${args.itemId}` };
  if (name === 'update_item_props') {
    ctx.commands.updateItemProps(item.id, (args.props ?? {}) as Args);
    return { ok: true, itemId: item.id, updated: Object.keys((args.props ?? {}) as Args) };
  }
  if (name === 'move_item') {
    const kind = item.kind === 'audio' ? 'audio' : 'video';
    const track = args.track === undefined ? undefined : resolveTrackId(ctx.getState(), args.track, kind);
    if (args.track !== undefined && !track) return { error: `no compatible track ${args.track}` };
    ctx.commands.moveItem(item.id, { track: track ?? undefined, startFrame: args.startFrame as number });
    return { ok: true, itemId: item.id };
  }
  if (name === 'duplicate_item') ctx.commands.duplicateItem(item.id);
  else if (name === 'remove_item' && args.ripple === true) ctx.commands.rippleDeleteItem(item.id);
  else if (name === 'remove_item') ctx.commands.removeItem(item.id);
  else if (name === 'split_item') ctx.commands.splitItem(item.id, Number(args.atFrame));
  if (name === 'duplicate_item') return { ok: true, duplicated: item.name };
  if (name === 'remove_item') return { ok: true, removed: item.name, ripple: args.ripple === true };
  return { ok: true, itemId: item.id };
}

function mutateProject(name: string, args: Args, ctx: AgentContext): unknown {
  if (name === 'clear_timeline') {
    ctx.commands.clearTimeline();
    return { ok: true };
  }
  const preset = ASPECT_PRESETS.find((candidate) => candidate.label === String(args.ratio));
  if (!preset) return { error: `unknown ratio ${args.ratio}` };
  const fit = (args.fit as AspectFit) ?? ctx.getState().fit ?? 'contain';
  ctx.commands.setAspect(preset.width, preset.height, fit);
  return { ok: true, ratio: preset.label, width: preset.width, height: preset.height, fit };
}

export function execCoreDataTool(name: string, args: Args, ctx: AgentContext): unknown | undefined {
  if (name === 'read_timeline') return readTimeline(ctx);
  if (name === 'clear_timeline' || name === 'set_aspect_ratio') return mutateProject(name, args, ctx);
  if ([
    'update_item_props',
    'move_item',
    'set_item_timing',
    'duplicate_item',
    'remove_item',
    'split_item',
  ].includes(name)) return mutateItem(name, args, ctx);
  return undefined;
}
