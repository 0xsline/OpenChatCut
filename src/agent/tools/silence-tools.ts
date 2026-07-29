// remove_silence - delete dead air (silent segment): native WebAudio analysis, no network connection.
// Detected in src/audio/silence.ts (relative voice level + absolute lower limit + breathing port),
// Edit in src/editor/silenceRebuild.ts(split/remove string batch, one step undo,
// Co-orbital ripple closure). The word-level path for transcribing clip belongs to clean_script, which is a gatekeeper here.
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { TimelineItem } from '../../editor/types';
import type { Action } from '../../editor/reduce';
import { analyzeClipSilence, SILENCE_DEFAULTS, type SilenceSpan } from '../../audio/silence';
import { planSilenceRemoval, silenceRemovalBlocker, spansToLocalCuts } from '../../editor/silenceRebuild';

type Args = Record<string, unknown>;

export const SILENCE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'remove_silence',
    description: [
      'Remove dead air — quiet, speech-free stretches — from clips, ripple-closing each gap on its own track (ONE undoable batch).',
      'Detection is on-device and relative: a stretch counts as silence only when its level sits well below the clip\'s own speech level',
      '(so music beds and loud ambience are never cut), it lasts at least minSilenceMs, and a padMs breathing room is kept on both sides.',
      'Use this to tighten pacing (long pauses, dead space between takes). It complements word-level editing:',
      'transcribed clips that already have word edits or gap caps are skipped — use clean_script there, it trims pauses word-precisely.',
      'Clips with playbackRate≠1 or an animated zoom are skipped (reported in skipped[]). Ripple is per-track: other tracks do not shift.',
      'Call once with NO itemId to sweep every audio/video clip on the active timeline; pass itemId for a single clip.',
      'Pass dryRun:true to preview the cut list (seconds) without editing.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Only this clip (prefix id ok). Omit to process every audio/video clip.' },
        thresholdDb: { type: 'number', minimum: -60, maximum: -6, description: `Silence gate relative to the clip's speech level in dB (default ${SILENCE_DEFAULTS.thresholdDb}; more negative = more conservative).` },
        minSilenceMs: { type: 'number', minimum: 200, maximum: 10000, description: `Only remove pauses at least this long (default ${SILENCE_DEFAULTS.minSilenceMs}ms).` },
        padMs: { type: 'number', minimum: 0, maximum: 1000, description: `Breathing room kept on each side of a cut (default ${SILENCE_DEFAULTS.padMs}ms).` },
        dryRun: { type: 'boolean', description: 'true = report the would-be cuts without editing.' },
      },
    },
  },
];

export const SILENCE_TOOL_NAMES = new Set(SILENCE_TOOL_SCHEMAS.map((t) => t.name));

function targetItems(ctx: AgentContext, itemId: unknown): TimelineItem[] | { error: string } {
  const clips = ctx.getState().items.filter((it) => it.kind === 'video' || it.kind === 'audio');
  const q = itemId === undefined || itemId === null ? '' : String(itemId);
  if (!q) return clips;
  const match = clips.find((it) => it.id === q || it.id.startsWith(q));
  return match ? [match] : { error: `no audio/video clip ${q}` };
}

export async function execSilenceTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'remove_silence') return { error: `unknown tool ${name}` };
  const params = {
    thresholdDb: typeof args.thresholdDb === 'number' ? args.thresholdDb : undefined,
    minSilenceMs: typeof args.minSilenceMs === 'number' ? args.minSilenceMs : undefined,
    padMs: typeof args.padMs === 'number' ? args.padMs : undefined,
  };
  const targets = targetItems(ctx, args.itemId);
  if ('error' in targets) return targets;
  const state = ctx.getState();
  const fps = state.fps;

  const skipped: Array<{ itemId: string; note: string }> = [];
  const edited: Array<{ itemId: string; removedSec: number; cuts: Array<{ fromSec: number; toSec: number }> }> = [];
  const allActions: Action[] = [];
  const spanCache = new Map<string, Promise<SilenceSpan[]>>();
  /** The number of frames deleted from the previous clip on the same track → Shift left by this amount before planning subsequent clips.*/
  const trackShift = new Map<string, number>();

  const ordered = [...targets].sort((a, b) => a.track === b.track ? a.startFrame - b.startFrame : String(a.track).localeCompare(String(b.track)));
  for (const item of ordered) {
    const blocker = silenceRemovalBlocker(item);
    if (blocker) {
      skipped.push({ itemId: item.id, note: blocker });
      continue;
    }
    try {
      if (!spanCache.has(item.src!)) spanCache.set(item.src!, analyzeClipSilence(item.src!, params));
      const spans = await spanCache.get(item.src!)!;
      const cuts = spansToLocalCuts(item, spans, fps);
      if (!cuts.length) continue;
      const shifted = { ...item, startFrame: item.startFrame - (trackShift.get(item.track) ?? 0) };
      const plan = planSilenceRemoval(shifted, cuts, () => crypto.randomUUID());
      if (!plan.actions.length) continue;
      allActions.push(...plan.actions);
      trackShift.set(item.track, (trackShift.get(item.track) ?? 0) + plan.removedFrames);
      edited.push({
        itemId: item.id,
        removedSec: Math.round((plan.removedFrames / fps) * 100) / 100,
        cuts: plan.cuts.map((c) => ({
          fromSec: Math.round((c.fromFrame / fps) * 100) / 100,
          toSec: Math.round((c.toFrame / fps) * 100) / 100,
        })),
      });
    } catch (e) {
      skipped.push({ itemId: item.id, note: `分析失败: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (args.dryRun === true) {
    return { ok: true, dryRun: true, wouldEdit: edited, ...(skipped.length ? { skipped } : {}) };
  }
  if (allActions.length) ctx.commands.batch(allActions, '删除静音');
  return {
    ok: true,
    edited,
    ...(skipped.length ? { skipped } : {}),
    ...(edited.length ? {} : { note: '未发现可删的死气段(阈值内没有足够长的静音)' }),
  };
}
