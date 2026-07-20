import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { analyzeClipLoudness, gainForTarget } from '../../audio/loudness';

// normalize_loudness —— 响度归一(目标默认 -14 LUFS,流媒体平台标准)。
// 命名风格同 isolate_voice/edit_captions(动词_名词)。
//
// 纯离线 WebAudio 分析(src/audio/loudness.ts),不落新的 store 动作——增益直接
// 复用已有的 `setItemVolume` 命令(响度归一在这个模型里就是"算出正确的 volume")。

type Args = Record<string, unknown>;

const DEFAULT_TARGET_LUFS = -14;

export const LOUDNESS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'normalize_loudness',
    description:
      'Normalize audio clip(s) to a target integrated loudness (LUFS) by analyzing each clip offline (WebAudio) and applying the computed gain as the clip volume. Defaults to -14 LUFS (streaming loudness standard). To normalize MANY/all clips, call this ONCE with NO itemId — a single call processes every audio clip on the active timeline and returns per-clip results ({itemId, measuredLufs, gain}). Do NOT call it once per clip. Pass itemId ONLY to normalize a single specific clip.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'number', description: 'Target integrated loudness in LUFS (default -14).' },
        itemId: { type: 'string', description: 'Normalize only this clip (prefix id ok). Omit to normalize all audio clips.' },
      },
    },
  },
];

export const LOUDNESS_TOOL_NAMES = new Set(LOUDNESS_TOOL_SCHEMAS.map((t) => t.name));

/** 目标音频 clip 集合:给了 itemId 就只找那一条(前缀匹配),否则时间线上所有 audio clip。 */
function findAudioItems(ctx: AgentContext, itemId: unknown) {
  const audioItems = ctx.getState().items.filter((it) => it.kind === 'audio');
  const q = itemId === undefined || itemId === null ? '' : String(itemId);
  if (!q) return audioItems;
  const match = audioItems.find((it) => it.id === q || it.id.startsWith(q));
  return match ? [match] : [];
}

export async function execLoudnessTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'normalize_loudness') return { error: `unknown tool ${name}` };

  const target = typeof args.target === 'number' && Number.isFinite(args.target) ? args.target : DEFAULT_TARGET_LUFS;
  const items = findAudioItems(ctx, args.itemId);
  if (items.length === 0) {
    return args.itemId
      ? { error: `no audio clip ${args.itemId}` }
      : { ok: true, normalized: [], target, note: 'timeline 上没有音频 clip' };
  }

  const normalized: { itemId: string; measuredLufs: number; gain: number }[] = [];
  const skipped: { itemId: string; note: string }[] = [];

  for (const item of items) {
    if (!item.src) {
      skipped.push({ itemId: item.id, note: 'no src' }); // 无源不可分析,跳过不抛错
      continue;
    }
    try {
      const measuredLufs = await analyzeClipLoudness(item.src);
      const gain = gainForTarget(measuredLufs, target);
      ctx.commands.setItemVolume(item.id, gain); // 复用既有命令,不新增 reducer 动作
      normalized.push({ itemId: item.id, measuredLufs, gain });
    } catch (e) {
      skipped.push({ itemId: item.id, note: `解码失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { ok: true, normalized, target, ...(skipped.length > 0 ? { skipped } : {}) };
}
