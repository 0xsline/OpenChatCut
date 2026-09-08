export { LOUDNESS_TOOL_SCHEMAS, LOUDNESS_TOOL_NAMES } from './schemas/loudness-tools';
import type { AgentContext } from '../context';
import { analyzeLoudnessBatch, gainForTarget } from '../../audio/loudness';
import { captureTimelineItemSource, validateTimelineItemSourceResult } from '../../editor/mediaSourceRevision';

// normalize_loudness - Normalize loudness (target default -14 LUFS, streaming platform standard).
// The naming style is the same as isolate_voice/edit_captions(verb_noun).
//
// Pure offline WebAudio analysis (src/audio/loudness.ts), no new store actions - direct gain
// Reuse the existing `setItemVolume` command (loudness normalization in this model is "calculating the correct volume").

type Args = Record<string, unknown>;

const DEFAULT_TARGET_LUFS = -14;

/** Target audio clip collection: given the itemId, only find that one (prefix matching), otherwise all audio clips on the timeline. */
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
  const doc = ctx.getDoc();
  const snapshots = items.map((item) => captureTimelineItemSource(item, doc.assets));
  const analyses = await analyzeLoudnessBatch(snapshots.map((snapshot) => snapshot.src).filter(Boolean));
  for (const snapshot of snapshots) {
    if (!snapshot.src) {
      skipped.push({ itemId: snapshot.itemId, note: 'no src' });
      continue;
    }
    try {
      const analysis = analyses.get(snapshot.src)!;
      if (analysis.status === 'rejected') throw analysis.reason;
      const current = ctx.getState().items.find((item) => item.id === snapshot.itemId);
      if (ctx.getDoc().activeTimelineId !== doc.activeTimelineId || validateTimelineItemSourceResult(snapshot, current, ctx.getDoc().assets, snapshot.sourceRevision).status === 'stale') {
        skipped.push({ itemId: snapshot.itemId, note: '源素材已变化，请重试' });
        continue;
      }
      const measuredLufs = analysis.value;
      const gain = gainForTarget(measuredLufs, target);
      ctx.commands.setItemVolume(snapshot.itemId, gain);
      normalized.push({ itemId: snapshot.itemId, measuredLufs, gain });
    } catch (e) {
      skipped.push({ itemId: snapshot.itemId, note: `解码失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { ok: true, normalized, target, ...(skipped.length > 0 ? { skipped } : {}) };
}
