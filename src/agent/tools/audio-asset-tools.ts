import type { AgentContext } from '../context';
import type { AudioAsset } from '../../audio/library';
import { defaultTrackId, resolveTrackId, trackAlias } from '../../editor/types';

export const AUDIO_ASSET_TOOL_NAMES = new Set(['list_audio', 'add_audio']);

type Args = Record<string, unknown>;

function availableAudio(ctx: AgentContext) {
  const builtins = ctx.audio.map((asset) => ({ ...asset, source: 'builtin' as const }));
  const project = ctx.getDoc().assets
    .filter((asset) => asset.kind === 'audio')
    .map((asset) => ({ ...asset, category: 'project', source: 'project' as const }));
  return [...builtins, ...project];
}

function commandAudio(asset: ReturnType<typeof availableAudio>[number]): AudioAsset {
  const category: AudioAsset['category'] = asset.source === 'project'
    ? 'music'
    : asset.category as AudioAsset['category'];
  return {
    id: asset.id,
    name: asset.name,
    category,
    src: asset.src,
    durationInFrames: asset.durationInFrames,
  };
}

export function execAudioAssetTool(name: string, args: Args, ctx: AgentContext): unknown {
  const choices = availableAudio(ctx);
  if (name === 'list_audio') {
    return choices.map((asset) => ({
      id: asset.id,
      name: asset.name,
      category: asset.category,
      source: asset.source,
      seconds: Math.round(asset.durationInFrames / (ctx.getState().fps || 30)),
    }));
  }
  const q = String(args.audioName ?? '').trim().toLowerCase();
  if (!q) return { error: 'audioName is required; call list_audio to choose an asset' };
  const asset = choices.find((candidate) => candidate.id.toLowerCase() === q)
    ?? choices.find((candidate) => candidate.id.toLowerCase().startsWith(q))
    ?? choices.find((candidate) => candidate.name.toLowerCase().includes(q));
  if (!asset) return { error: `no audio matching "${args.audioName}"`, available: choices.map((a) => a.name) };
  const state = ctx.getState();
  const requestedTrack = args.track ?? 'A1';
  const resolvedTrack = resolveTrackId(state, requestedTrack, 'audio');
  if (args.track != null && !resolvedTrack) {
    return { error: `audio track "${String(args.track)}" not found; call edit_track action=list` };
  }
  const track = resolvedTrack ?? defaultTrackId(state, 'audio');
  if (!track) return { error: 'no audio track; create one with edit_track first' };
  ctx.commands.addAudio(commandAudio(asset), {
    track,
    startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
    ripple: args.ripple === true,
  });
  return {
    ok: true,
    added: asset.name,
    assetId: asset.id,
    source: asset.source,
    trackId: track,
    track: trackAlias(ctx.getState(), track),
  };
}
