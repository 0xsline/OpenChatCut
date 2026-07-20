// isolate_voice — AI Voice Isolation open-box path.
// Voice isolation uses POST /api/isolate-voice locally (ffmpeg afftdn /
// speech-band chain) → setItemDenoise(denoisedSrc). action=clear detaches isolation.
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
      'action=clear removes isolation and restores original audio. ' +
      'strength 0..100 (default 70). Requires /media/uploads source (upload/finalize first).',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Target video/audio clip id (prefix ok).' },
        action: {
          type: 'string',
          enum: ['apply', 'clear'],
          description: 'apply = run isolation; clear = detach denoisedSrc.',
        },
        strength: {
          type: 'number',
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

  if (action !== 'apply') {
    return { error: `unknown action ${action}（用 apply 或 clear）` };
  }

  const src = item.src ?? '';
  if (!src.startsWith('/media/uploads/')) {
    return {
      error: 'isolate_voice 需要 /media/uploads 源文件（请先 finalize/上传到媒体池）。blob: 占位预览尚不可隔离。',
      src: src || null,
    };
  }

  const strength = Number.isFinite(Number(args.strength))
    ? Math.max(0, Math.min(100, Number(args.strength)))
    : 70;

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
