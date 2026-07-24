// isolate_voice — generate, attach, or clear a speech-isolation track.
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { TimelineItem } from '../../editor/types';
import { isolateVoiceOnSrc } from '../../audio/isolateVoice';

type Args = Record<string, unknown>;

export const ISOLATE_VOICE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'isolate_voice',
    description:
      'AI Voice Isolation: reduce background noise on a video/audio clip so speech is clearer. ' +
      'action=apply (default) runs an open-box ffmpeg spectral denoise on the clip source and attaches the result as denoisedSrc (master src stays intact; playback uses the isolated track). ' +
      'action=attach points the clip at an existing audio asset after validating denoisedAssetId and sourceAssetId. ' +
      'action=clear removes isolation and restores original audio. ' +
      'strength 0..100 (default 70). Requires /media/uploads source (upload/finalize first).',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target video/audio clip id (prefix ok).' },
        action: {
          type: 'string',
          enum: ['apply', 'attach', 'clear'],
          description: 'apply = run isolation; attach = use an existing isolated audio asset; clear = detach it.',
        },
        sourceAssetId: {
          type: 'string',
          description: 'attach: source audio/video asset id or unique prefix. It must match the target clip source.',
        },
        denoisedAssetId: {
          type: 'string',
          description: 'attach: existing audio asset id or unique prefix containing the isolated full-source audio.',
        },
        strength: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Denoise strength 0..100 (default 70). Higher = more aggressive NR.',
        },
      },
      required: ['itemId'],
    },
  },
];

export const ISOLATE_VOICE_TOOL_NAMES = new Set(ISOLATE_VOICE_TOOL_SCHEMAS.map((t) => t.name));

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const q = String(id ?? '');
  if (!q) return null;
  return items.find((it) => it.id === q || it.id.startsWith(q)) ?? null;
}

function findAsset(
  assets: ReturnType<AgentContext['getDoc']>['assets'],
  id: unknown,
): { asset?: (typeof assets)[number]; error?: string; candidates?: Array<{ id: string; name: string; kind: string }> } {
  const query = String(id ?? '').trim();
  if (!query) return { error: 'missing material id' };
  const exact = assets.find((asset) => asset.id === query);
  const matches = exact ? [exact] : assets.filter((asset) => asset.id.startsWith(query));
  if (!matches.length) return { error: `Material not found ${query}` };
  if (matches.length > 1) {
    return {
      error: `Material prefix ${query} Not unique`,
      candidates: matches.slice(0, 6).map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind })),
    };
  }
  return { asset: matches[0] };
}

export async function execIsolateVoiceTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'isolate_voice') return { error: `unknown tool ${name}` };

  const state = ctx.getState();
  const item = findItem(state.items, args.itemId);
  if (!item) {
    return {
      error: `not found clip ${args.itemId ?? '(missing itemId)'}`,
      available: state.items
        .filter((it) => it.kind === 'video' || it.kind === 'audio')
        .map((it) => ({ itemId: it.id, name: it.name, kind: it.kind })),
    };
  }
  if (item.kind !== 'video' && item.kind !== 'audio') {
    return { error: `isolate_voice only applies to video/audio, currently kind=${item.kind}` };
  }

  const action = String(args.action ?? 'apply').toLowerCase();
  if (action === 'clear') {
    if (!item.denoisedSrc) {
      return { ok: true, itemId: item.id, action: 'clear', note: 'There is no vocal isolation' };
    }
    ctx.commands.setItemDenoise(item.id, null);
    return { ok: true, itemId: item.id, action: 'clear', denoisedSrc: null };
  }

  const strength = Number.isFinite(Number(args.strength))
    ? Math.max(0, Math.min(100, Number(args.strength)))
    : 70;

  if (action === 'attach') {
    const assets = ctx.getDoc().assets ?? [];
    const sourceMatch = findAsset(assets, args.sourceAssetId);
    if (!sourceMatch.asset) return { error: `sourceAssetId: ${sourceMatch.error}`, candidates: sourceMatch.candidates };
    const sourceAsset = sourceMatch.asset;
    if (sourceAsset.kind !== 'audio' && sourceAsset.kind !== 'video') {
      return { error: `sourceAssetId must be video/audio, currently kind=${sourceAsset.kind}` };
    }
    if (!item.src || item.src !== sourceAsset.src) {
      return {
        error: 'sourceAssetId Does not match target fragment source',
        itemSrc: item.src ?? null,
        sourceAssetId: sourceAsset.id,
        sourceSrc: sourceAsset.src,
      };
    }

    const denoisedMatch = findAsset(assets, args.denoisedAssetId);
    if (!denoisedMatch.asset) return { error: `denoisedAssetId: ${denoisedMatch.error}`, candidates: denoisedMatch.candidates };
    const denoisedAsset = denoisedMatch.asset;
    if (denoisedAsset.kind !== 'audio') {
      return { error: `denoisedAssetId must be audio, currently kind=${denoisedAsset.kind}` };
    }
    if (denoisedAsset.id === sourceAsset.id || denoisedAsset.src === sourceAsset.src) {
      return { error: 'denoisedAssetId Cannot be the same as the source material' };
    }

    const unchanged = item.denoisedSrc === denoisedAsset.src
      && (item.denoiseStrength ?? 100) === strength;
    ctx.commands.setItemDenoise(item.id, denoisedAsset.src, strength);
    return {
      ok: true,
      itemId: item.id,
      action: 'attach',
      sourceAssetId: sourceAsset.id,
      denoisedAssetId: denoisedAsset.id,
      denoisedSrc: denoisedAsset.src,
      strength,
      unchanged,
      note: 'Detached audio from the media pool is mounted; neither the source material nor the shared material has been modified.',
    };
  }

  if (action !== 'apply') {
    return { error: `unknown action ${action}(Use apply、attach or clear）` };
  }

  if (args.sourceAssetId) {
    const sourceMatch = findAsset(ctx.getDoc().assets ?? [], args.sourceAssetId);
    if (!sourceMatch.asset) return { error: `sourceAssetId: ${sourceMatch.error}`, candidates: sourceMatch.candidates };
    if (sourceMatch.asset.src !== item.src) return { error: 'sourceAssetId Does not match target fragment source' };
  }

  const src = item.src ?? '';
  if (!src.startsWith('/media/uploads/')) {
    return {
      error: 'isolate_voice need /media/uploads Source file (please first finalize/uploaded to the media pool).blob: Placeholder previews are not yet available for isolation.',
      src: src || null,
    };
  }

  try {
    const r = await isolateVoiceOnSrc(src, strength);
    ctx.commands.setItemDenoise(item.id, r.path, r.strength);
    return {
      ok: true,
      itemId: item.id,
      action: 'apply',
      denoisedSrc: r.path,
      strength: r.strength,
      engine: r.engine ?? 'ffmpeg-open-box',
      bytes: r.bytes,
      note: 'Open-box ffmpeg denoise attached; original src unchanged. action=clear to remove.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'isolate_voice Request failed';
    return {
      error: msg,
      hint: /503|ffmpeg|spawn/i.test(msg)
        ? 'local machine ffmpeg Not available; can be re-imported after external noise reduction, or installed ffmpeg。'
        : 'Confirm dev server Mounted /api/isolate-voice, and the source file is in /media/uploads。',
    };
  }
}
