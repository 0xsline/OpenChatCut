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
  if (!query) return { error: '缺少素材 id' };
  const exact = assets.find((asset) => asset.id === query);
  const matches = exact ? [exact] : assets.filter((asset) => asset.id.startsWith(query));
  if (!matches.length) return { error: `找不到素材 ${query}` };
  if (matches.length > 1) {
    return {
      error: `素材前缀 ${query} 不唯一`,
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
      error: `找不到 clip ${args.itemId ?? '(缺 itemId)'}`,
      available: state.items
        .filter((it) => it.kind === 'video' || it.kind === 'audio')
        .map((it) => ({ itemId: it.id, name: it.name, kind: it.kind })),
    };
  }
  if (item.kind !== 'video' && item.kind !== 'audio') {
    return { error: `isolate_voice 只适用于 video/audio，当前 kind=${item.kind}` };
  }

  const action = String(args.action ?? 'apply').toLowerCase();
  if (action === 'clear') {
    if (!item.denoisedSrc) {
      return { ok: true, itemId: item.id, action: 'clear', note: '本来就没有人声隔离' };
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
      return { error: `sourceAssetId 必须是 video/audio，当前 kind=${sourceAsset.kind}` };
    }
    if (!item.src || item.src !== sourceAsset.src) {
      return {
        error: 'sourceAssetId 与目标片段来源不匹配',
        itemSrc: item.src ?? null,
        sourceAssetId: sourceAsset.id,
        sourceSrc: sourceAsset.src,
      };
    }

    const denoisedMatch = findAsset(assets, args.denoisedAssetId);
    if (!denoisedMatch.asset) return { error: `denoisedAssetId: ${denoisedMatch.error}`, candidates: denoisedMatch.candidates };
    const denoisedAsset = denoisedMatch.asset;
    if (denoisedAsset.kind !== 'audio') {
      return { error: `denoisedAssetId 必须是 audio，当前 kind=${denoisedAsset.kind}` };
    }
    if (denoisedAsset.id === sourceAsset.id || denoisedAsset.src === sourceAsset.src) {
      return { error: 'denoisedAssetId 不能与源素材相同' };
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
      note: '已挂载媒体池中的分离音频；源素材与共享素材均未修改。',
    };
  }

  if (action !== 'apply') {
    return { error: `unknown action ${action}（用 apply、attach 或 clear）` };
  }

  if (args.sourceAssetId) {
    const sourceMatch = findAsset(ctx.getDoc().assets ?? [], args.sourceAssetId);
    if (!sourceMatch.asset) return { error: `sourceAssetId: ${sourceMatch.error}`, candidates: sourceMatch.candidates };
    if (sourceMatch.asset.src !== item.src) return { error: 'sourceAssetId 与目标片段来源不匹配' };
  }

  const src = item.src ?? '';
  if (!src.startsWith('/media/uploads/')) {
    return {
      error: 'isolate_voice 需要 /media/uploads 源文件（请先 finalize/上传到媒体池）。blob: 占位预览尚不可隔离。',
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
    const msg = err instanceof Error ? err.message : 'isolate_voice 请求失败';
    return {
      error: msg,
      hint: /503|ffmpeg|spawn/i.test(msg)
        ? '本机 ffmpeg 不可用；可外部降噪后重新导入，或安装 ffmpeg。'
        : '确认 dev server 已挂载 /api/isolate-voice，且源文件在 /media/uploads。',
    };
  }
}
