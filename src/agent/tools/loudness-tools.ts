import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { analyzeClipLoudness, gainForTarget } from '../../audio/loudness';

// normalize_loudness - Normalize loudness (target default -14 LUFS, streaming platform standard).
// The naming style is the same as isolate_voice/edit_captions (verb_noun).
//
// Pure offline WebAudio analysis (src/audio/loudness.ts), no new store actions - direct gain
// Reuse the existing `setItemVolume` command (loudness normalization in this model is "calculating the correct volume").

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

/** target audio clip collection:gave itemId Just look for that one(prefix matching),Otherwise all on the timeline audio clip。 */
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
      : { ok: true, normalized: [], target, note: 'timeline no audio on clip' };
  }

  const normalized: { itemId: string; measuredLufs: number; gain: number }[] = [];
  const skipped: { itemId: string; note: string }[] = [];

  for (const item of items) {
    if (!item.src) {
      skipped.push({ itemId: item.id, note: 'no src' }); // Passive source cannot be analyzed, skipping will not throw an error
      continue;
    }
    try {
      const measuredLufs = await analyzeClipLoudness(item.src);
      const gain = gainForTarget(measuredLufs, target);
      ctx.commands.setItemVolume(item.id, gain); // Reuse existing commands without adding reducer actions
      normalized.push({ itemId: item.id, measuredLufs, gain });
    } catch (e) {
      skipped.push({ itemId: item.id, note: `Decoding failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { ok: true, normalized, target, ...(skipped.length > 0 ? { skipped } : {}) };
}
