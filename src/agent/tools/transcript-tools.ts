export { TRANSCRIPT_TOOL_SCHEMAS, TRANSCRIPT_TOOL_NAMES } from './schemas/transcript-tools';
import type { AgentContext } from '../context';
import { defaultTrackId, resolveTrackId, trackAlias, type TimelineItem, type TrackId } from '../../editor/types';
import { transcribePath, TranscriptionError } from '../../transcript/provider';
import { hasOperationalTranscript, isTranscriptionProviderId } from '../../transcript/types';
import { fillerIndices } from '../../transcript/edit';
import { translateLines } from '../../captions/translate';
import { createVariant, findVariantByLang, upsertVariant } from '../../transcript/variants';
import { buildSilenceGapCaps, parseCleanOnly, parseSilenceRule, type SilenceRule } from '../../transcript/clean';
import type { Action } from '../../editor/reduce';
import { execFindTranscript, findPhrase, normalize } from './transcript-find';
import { execReadTranscript } from './transcript-read';
import { execSearchMedia } from './media-search';

type Args = Record<string, unknown>;

// normalize / findPhrase live in transcript-find.ts (shared with the find_transcript
// executor and manage_markers' transcriptSegments anchoring).

// audio clip on a track, optionally requiring an attached transcript
function trackClip(ctx: AgentContext, track: TrackId, needTranscript: boolean): TimelineItem | null {
  return ctx.getState().items.find((it) =>
    (it.kind === 'audio' || it.kind === 'video') && it.track === track && it.src && (!needTranscript || hasOperationalTranscript(it))) ?? null;
}

function resolveClip(ctx: AgentContext, track: TrackId, itemId: unknown, needTranscript: boolean): TimelineItem | null {
  const items = ctx.getState().items;
  if (typeof itemId === 'string' && itemId.trim()) {
    const q = itemId.trim();
    return items.find((x) => x.id === q || x.id.startsWith(q)) ?? null;
  }
  return trackClip(ctx, track, needTranscript);
}

interface ListedGap {
  gapIndex: number;
  afterWordIndex: number;
  gapSeconds: number;
  appliedSeconds: number;
  removed: boolean;
  beforeText: string;
  afterText: string;
}

/** Gaps between consecutive kept words (same rules as UI Gap rows). */
function listGapsOnClip(it: TimelineItem, minGapSeconds = 0.25): ListedGap[] {
  const words = it.transcript ?? [];
  if (words.length < 2) return [];
  const del = new Set(it.deletedWordIdx ?? []);
  const kept = words.map((w, i) => ({ w, i })).filter((x) => !del.has(x.i));
  const minMs = Math.max(0, minGapSeconds * 1000);
  const caps = it.gapCapsMs ?? {};
  const out: ListedGap[] = [];
  for (let k = 1; k < kept.length; k++) {
    const prev = kept[k - 1]!;
    const cur = kept[k]!;
    const rawMs = Math.max(0, cur.w.start - prev.w.end);
    const key = String(cur.i);
    const hasCap = Object.prototype.hasOwnProperty.call(caps, key);
    const appliedMs = hasCap ? Math.min(rawMs, Math.max(0, caps[key]!)) : rawMs;
    const removed = hasCap && (caps[key] ?? 0) <= 30;
    if (rawMs < minMs && !removed && !hasCap) continue;
    out.push({
      gapIndex: out.length,
      afterWordIndex: cur.i,
      gapSeconds: Math.round((rawMs / 1000) * 100) / 100,
      appliedSeconds: Math.round((appliedMs / 1000) * 100) / 100,
      removed,
      beforeText: words.slice(Math.max(0, prev.i - 2), prev.i + 1).map((w) => w.text).join(''),
      afterText: words.slice(cur.i, Math.min(words.length, cur.i + 3)).map((w) => w.text).join(''),
    });
  }
  return out;
}

function resolveAfterWordIndex(
  it: TimelineItem,
  args: Args,
  gaps: ListedGap[],
): { afterWordIndex: number } | { error: string } {
  if (typeof args.afterWordIndex === 'number' && Number.isFinite(args.afterWordIndex)) {
    const i = Math.round(args.afterWordIndex);
    if (i <= 0 || i >= (it.transcript?.length ?? 0)) {
      return { error: `afterWordIndex ${i} out of range (1..${(it.transcript?.length ?? 1) - 1})` };
    }
    return { afterWordIndex: i };
  }
  if (typeof args.gapIndex === 'number' && Number.isFinite(args.gapIndex)) {
    const g = gaps[Math.round(args.gapIndex)];
    if (!g) return { error: `gapIndex ${args.gapIndex} out of range (0..${Math.max(0, gaps.length - 1)})` };
    return { afterWordIndex: g.afterWordIndex };
  }
  if (typeof args.afterText === 'string' && args.afterText.trim()) {
    const m = findPhrase(it.transcript!, args.afterText);
    if (!m) return { error: `afterText not found: ${args.afterText}` };
    // gap is immediately before the first word of the match
    if (m.start <= 0) return { error: 'afterText matches the start of the transcript; no gap before it' };
    return { afterWordIndex: m.start };
  }
  return { error: 'provide afterWordIndex, gapIndex, or afterText to locate the gap' };
}

// manage_transcript: fix / clear_edits / retry_transcription / translation_*.
// fix and translation_* keep word timing and clip length; clear_edits restores
// the full transcript duration; only word .text / .speaker or a VARIANT change
// for the non-retimes paths.
async function manageTranscript(args: Args, ctx: AgentContext, track: TrackId, alias: string): Promise<unknown> {
  const action = String(args.action ?? '');
  const it = resolveClip(ctx, track, args.itemId, action !== 'retry_transcription');
  if (!it) {
    return {
      error: args.itemId
        ? `no item ${String(args.itemId)}`
        : action === 'retry_transcription'
          ? `no audio/video clip on ${alias}`
          : `no transcribed clip on ${alias}; call transcribe_track first`,
    };
  }

  // retry_transcription: force a fresh ASR run (the only action that doesn't need an existing transcript).
  if (action === 'retry_transcription') {
    if (!it.src) return { error: `item ${it.id} has no media to transcribe` };
    try {
      const r = await transcribePath(it.src);
      ctx.commands.setItemTranscript(it.id, r.words);
      return { ok: true, action, itemId: it.id, words: r.words.length, text: r.text.slice(0, 200), retried: true };
    } catch (e) {
      return { error: `transcription failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (!hasOperationalTranscript(it)) return { error: `item ${it.id} has no current transcript; call transcribe_track first` };

  if (action === 'clear_edits') {
    const deletedWords = (it.deletedWordIdx ?? []).length;
    const gapOverrides = Object.keys(it.gapCapsMs ?? {}).length;
    const hadSilenceCap = it.silenceFrames !== undefined;
    const hadPlayOrder = Array.isArray(it.transcriptPlayOrder) && it.transcriptPlayOrder.length > 0;
    ctx.commands.clearEdits(it.id);
    const after = ctx.getState().items.find((x) => x.id === it.id);
    return {
      ok: true,
      action,
      itemId: it.id,
      restored: {
        deletedWords,
        gapOverrides,
        silenceCap: hadSilenceCap,
        playOrder: hadPlayOrder,
      },
      durationInFrames: after?.durationInFrames ?? null,
      note: 'Restored raw transcript edits (deleted words, silence/gap caps, play order). ASR word text and speaker labels are unchanged.',
    };
  }

  if (action === 'set_play_order') {
    if (args.clearPlayOrder === true || args.playOrder === null) {
      ctx.commands.setTranscriptPlayOrder(it.id, null);
      const after = ctx.getState().items.find((x) => x.id === it.id);
      return {
        ok: true,
        action,
        itemId: it.id,
        playOrder: null,
        durationInFrames: after?.durationInFrames ?? null,
        note: 'Chronological word order restored.',
      };
    }
    if (!Array.isArray(args.playOrder)) {
      return { error: 'set_play_order needs playOrder:[wordIndex,…] or clearPlayOrder:true' };
    }
    const n = it.transcript.length;
    const cleaned = args.playOrder
      .map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < n);
    if (!cleaned.length) return { error: `playOrder must list word indices in 0..${n - 1}` };
    ctx.commands.setTranscriptPlayOrder(it.id, cleaned);
    const after = ctx.getState().items.find((x) => x.id === it.id);
    return {
      ok: true,
      action,
      itemId: it.id,
      playOrder: after?.transcriptPlayOrder ?? cleaned,
      durationInFrames: after?.durationInFrames ?? null,
    };
  }

  if (action === 'fix') {
    // fix supports ASR word correction or speaker rename/merge, routed by fields.
    if (typeof args.from === 'string' || typeof args.to === 'string') {
      const from = args.from, to = args.to;
      if (typeof from !== 'string' || !from.trim()) return { error: 'speaker fix needs from (the existing speaker label)' };
      if (typeof to !== 'string' || !to.trim()) return { error: 'speaker fix needs to (the new speaker name; an existing label merges the two)' };
      const wordsChanged = it.transcript.filter((w) => w.speaker === from).length;
      if (wordsChanged === 0) return { error: `no word labeled speaker "${from}" in item ${it.id}` };
      ctx.commands.renameSpeaker(it.id, from, to); // Only .speaker changes.
      return { ok: true, action, kind: 'speaker', itemId: it.id, from, to, wordsChanged };
    }
    const text = args.text;
    if (typeof text !== 'string' || !text.trim()) return { error: 'word fix needs text (the corrected word); or pass from/to for a speaker fix' };
    let wordIndex: number;
    if (typeof args.wordIndex === 'number') wordIndex = args.wordIndex;
    else if (typeof args.find === 'string' && args.find.trim()) {
      const findStr = args.find;
      wordIndex = it.transcript.findIndex((w) => w.text === findStr);
      if (wordIndex < 0) { const target = normalize(findStr); wordIndex = it.transcript.findIndex((w) => normalize(w.text) === target); }
      if (wordIndex < 0) return { error: `word not found: ${findStr}` };
    } else return { error: 'provide wordIndex or find to locate the word' };
    const word = it.transcript[wordIndex];
    if (!word) return { error: `wordIndex ${wordIndex} out of range (0..${it.transcript.length - 1})` };
    ctx.commands.fixTranscriptWord(it.id, wordIndex, text); // Only .text changes.
    return { ok: true, action, kind: 'word', itemId: it.id, wordIndex, from: word.text, to: text };
  }

  if (action === 'translation_list') {
    const variants = it.variants ?? [];
    return { ok: true, action, itemId: it.id, original: { words: it.transcript.length }, variants: variants.map((v) => ({ id: v.id, lang: v.lang, kind: v.kind, words: v.words.length })) };
  }
  if (action === 'translation_read') {
    const lang = String(args.lang ?? args.targetLanguage ?? '').trim();
    if (!lang) return { error: 'translation_read needs lang / targetLanguage (which variant to read)' };
    const v = it.variants ? findVariantByLang(it.variants, lang, 'translation') : undefined;
    if (!v) return { error: `no "${lang}" translation variant on item ${it.id}; create it with translation_create / translation_ensure first` };
    return { ok: true, action, itemId: it.id, lang: v.lang, variantId: v.id, words: v.words.length, text: v.words.map((w) => w.text).join(' ').slice(0, 400) };
  }

  // translation_create (always (re)translate + overwrite) / translation_ensure (idempotent: reuse if present).
  if (action === 'translation_create' || action === 'translation_ensure') {
    const lang = String(args.lang ?? '').trim();
    if (!lang) return { error: `${action} needs lang (target language, e.g. "English")` };
    const existing = findVariantByLang(it.variants, lang, 'translation');
    if (existing && action === 'translation_ensure') {
      return { ok: true, action, itemId: it.id, variantId: existing.id, lang: existing.lang, words: existing.words.length, reused: true };
    }
    try {
      // Each variant word is keyed by source index i; timing always comes from resolveVariantText.
      const texts = await translateLines(it.transcript.map((w) => w.text), lang);
      const words = texts.map((text, i) => ({ i, text }));
      const variant = createVariant({ lang, kind: 'translation', words, id: existing?.id }); // reuse id → overwrite
      ctx.commands.setItemVariants(it.id, upsertVariant(it.variants, variant));
      return { ok: true, action, itemId: it.id, variantId: variant.id, lang: variant.lang, words: variant.words.length, reused: false };
    } catch (e) {
      return { error: `translation failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return { error: `unsupported action "${action}"; use fix / clear_edits / set_play_order / retry_transcription / translation_create / translation_ensure / translation_list / translation_read` };
}

// Execute a transcript/caption tool. Returns undefined if `name` isn't one of ours.
export async function execTranscriptTool(name: string, args: Args, ctx: AgentContext): Promise<unknown | undefined> {
  if (name === 'read_transcript') return execReadTranscript(args, ctx);
  if (name === 'search_media') return execSearchMedia(args, ctx);
  const state = ctx.getState();
  const track = resolveTrackId(state, args.track ?? 'A1') ?? defaultTrackId(state, 'audio');
  if (!track) return { error: 'no track available; create one with edit_track first' };
  const alias = trackAlias(state, track);
  switch (name) {
    case 'transcribe_track': {
      const provider = args.provider === undefined
        ? undefined
        : isTranscriptionProviderId(args.provider) ? args.provider : undefined;
      if (args.provider !== undefined && provider === undefined) {
        return { error: `unsupported transcription provider: ${String(args.provider)}` };
      }
      // Transcribe ALL audio/video clips on the track (not just the first).
      const clips = ctx.getState().items
        .filter((it) => (it.kind === 'audio' || it.kind === 'video') && it.track === track && it.src)
        .sort((a, b) => a.startFrame - b.startFrame);
      if (!clips.length) return { error: `no audio/video clip on ${alias}` };
      const results: { itemId: string; words: number; text: string; skipped?: boolean; skippedReason?: string }[] = [];
      try {
        for (const it of clips) {
          if (hasOperationalTranscript(it)) {
            results.push({ itemId: it.id, words: it.transcript.length, text: '', skipped: true, skippedReason: 'already-transcribed' });
            continue;
          }
          try {
            const r = await transcribePath(it.src!, (note) => { if (note) ctx.onToolProgress?.(note); }, {}, provider);
            ctx.commands.setItemTranscript(it.id, r.words);
            results.push({ itemId: it.id, words: r.words.length, text: r.text.slice(0, 200) });
          } catch (transcribeError) {
            // Clips without an audio track are not transcription failures —
            // skip and report them instead of failing the whole batch.
            if (transcribeError instanceof TranscriptionError && transcribeError.code === 'no-audio') {
              results.push({ itemId: it.id, words: 0, text: '', skipped: true, skippedReason: 'no-audio' });
              continue;
            }
            throw transcribeError;
          }
        }
        return { ok: true, track: alias, provider: provider ?? 'settings-default', clips: results.length, results };
      } catch (e) {
        const base = e instanceof Error ? e.message : String(e);
        return { error: `transcription failed: ${base}`, partial: results };
      }
    }
    case 'find_transcript':
      // Parameter surface (asset/fuzzy/includeWordTimestamps/limit) + full project search: transcript-find.ts.
      return execFindTranscript(args, ctx);
    case 'clean_script': {
      // Whole-track batch: clean every
      // transcribed clip on the track, not just the first. itemId narrows to one clip.
      const targetId = typeof args.itemId === 'string' ? args.itemId : '';
      const clips = targetId
        ? state.items.filter((x) => (x.id === targetId || x.id.startsWith(targetId)) && hasOperationalTranscript(x))
        : state.items.filter((x) => x.track === track && hasOperationalTranscript(x));
      if (!clips.length) return { error: targetId ? `no transcribed item ${targetId}` : `no transcript on ${alias}; call transcribe_track first` };
      const fps = state.fps;
      const usesTypedArgs = args.only != null || args.silence != null || args.longSilence != null;
      let selection: { fillers: boolean; silence: boolean };
      let silenceRule: SilenceRule | undefined;
      try {
        selection = usesTypedArgs ? parseCleanOnly(args.only) : { fillers: args.removeFillers !== false, silence: typeof args.maxPauseSeconds === 'number' };
        silenceRule = parseSilenceRule(args.silence);
        if (selection.silence && !silenceRule && usesTypedArgs) {
          const thresholdMs = typeof args.longSilence === 'number' && Number.isFinite(args.longSilence)
            ? Math.max(0, Math.round(args.longSilence))
            : 3000;
          silenceRule = { mode: 'long', thresholdMs, targetMs: 200 };
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      const silenceFrames = typeof args.maxPauseSeconds === 'number'
        ? Math.max(1, Math.round(args.maxPauseSeconds * fps))
        : undefined;
      const cutPadFrames = typeof args.cutPadMs === 'number'
        ? Math.max(0, Math.round((Math.min(500, Math.max(0, args.cutPadMs)) / 1000) * fps))
        : undefined;
      const removeFillers = selection.fillers;
      let fillersRemoved = 0;
      const actions: Action[] = [];
      for (const it of clips) {
        const fillers = removeFillers ? fillerIndices(it.transcript!) : [];
        fillersRemoved += fillers.filter((index) => !(it.deletedWordIdx ?? []).includes(index)).length;
        if (selection.silence && silenceRule) {
          actions.push({
            type: 'cleanScript',
            id: it.id,
            removeFillers,
            gapCapsMs: buildSilenceGapCaps(it.transcript!, silenceRule, {
              silenceFrames: it.silenceFrames,
              gapCapsMs: it.gapCapsMs,
              fps,
            }),
            replaceGapCaps: true,
            cutPadFrames,
          });
        } else if (!usesTypedArgs) {
          actions.push({ type: 'cleanScript', id: it.id, silenceFrames, removeFillers, cutPadFrames });
        } else if (cutPadFrames !== undefined) {
          // When only changing the breathing port, keep the existing compression settings of the clip as they are, so they won't be cleared by cleanScript.
          actions.push({ type: 'cleanScript', id: it.id, removeFillers, cutPadFrames, silenceFrames: it.silenceFrames });
        } else if (fillers.length) {
          actions.push({ type: 'deleteWords', id: it.id, idxs: fillers });
        }
      }
      ctx.commands.batch(actions, 'Clean script');
      return {
        ok: true,
        track: alias,
        clips: clips.length,
        itemIds: clips.map((clip) => clip.id),
        only: usesTypedArgs ? Object.entries(selection).filter(([, enabled]) => enabled).map(([key]) => key).join(',') : null,
        silenceRule: silenceRule ?? null,
        maxPauseSeconds: (args.maxPauseSeconds as number) ?? null,
        fillersRemoved,
      };
    }
    case 'edit_gap': {
      const action = String(args.action ?? '');
      const it = resolveClip(ctx, track, args.itemId, true);
      if (!hasOperationalTranscript(it)) {
        return { error: args.itemId ? `no transcribed item ${String(args.itemId)}` : `no transcript on ${alias}; call transcribe_track first` };
      }
      const minGap = typeof args.minGapSeconds === 'number' ? args.minGapSeconds : 0.25;
      const gaps = listGapsOnClip(it, minGap);

      if (action === 'list') {
        return {
          ok: true,
          itemId: it.id,
          track: trackAlias(ctx.getState(), it.track),
          name: it.name,
          gapCount: gaps.length,
          gaps,
          usage: 'Pass afterWordIndex (or gapIndex / afterText) to edit_gap delete|cap|restore. Batch whole-track: clean_script.',
        };
      }

      const loc = resolveAfterWordIndex(it, args, gaps);
      if ('error' in loc) return loc;
      const afterWordIndex = loc.afterWordIndex;
      const prevWord = it.transcript[afterWordIndex - 1];
      const nextWord = it.transcript[afterWordIndex];
      const rawSec = prevWord && nextWord
        ? Math.max(0, (nextWord.start - prevWord.end) / 1000)
        : null;

      if (action === 'delete') {
        ctx.commands.setGapCap(it.id, afterWordIndex, 0);
        return {
          ok: true,
          action: 'delete',
          itemId: it.id,
          afterWordIndex,
          gapSecondsBefore: rawSec,
          appliedSeconds: 0,
          note: 'Gap silence removed; clip re-timed via gapCapsMs.',
        };
      }
      if (action === 'restore') {
        ctx.commands.setGapCap(it.id, afterWordIndex, null);
        return {
          ok: true,
          action: 'restore',
          itemId: it.id,
          afterWordIndex,
          gapSeconds: rawSec,
          note: 'Per-gap override cleared; original pause restored (unless clean_script global cap still applies).',
        };
      }
      if (action === 'cap') {
        if (typeof args.maxSeconds !== 'number' || !Number.isFinite(args.maxSeconds) || args.maxSeconds < 0) {
          return { error: 'cap requires maxSeconds ≥ 0 (e.g. 0.2)' };
        }
        const maxMs = Math.round(args.maxSeconds * 1000);
        ctx.commands.setGapCap(it.id, afterWordIndex, maxMs);
        return {
          ok: true,
          action: 'cap',
          itemId: it.id,
          afterWordIndex,
          gapSecondsBefore: rawSec,
          appliedSeconds: Math.min(rawSec ?? args.maxSeconds, args.maxSeconds),
          maxSeconds: args.maxSeconds,
        };
      }
      return { error: `unknown edit_gap action "${action}" (use list|delete|cap|restore)` };
    }
    case 'delete_text': {
      const it = trackClip(ctx, track, true);
      if (!hasOperationalTranscript(it)) return { error: `no current transcript on ${alias}; call transcribe_track first` };
      const m = findPhrase(it.transcript, String(args.query ?? ''));
      if (!m) return { deleted: false, query: args.query, note: 'phrase not found' };
      const idxs = Array.from({ length: m.count }, (_, k) => m.start + k);
      const text = it.transcript.slice(m.start, m.start + m.count).map((w) => w.text).join(' ');
      ctx.commands.deleteWords(it.id, idxs);
      return { ok: true, itemId: it.id, deletedWords: m.count, text };
    }
    case 'manage_transcript':
      return manageTranscript(args, ctx, track, alias);
    default:
      return undefined;
  }
}
