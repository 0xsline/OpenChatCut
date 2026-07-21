import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { defaultTrackId, resolveTrackId, trackAlias, type TimelineItem, type TrackId } from '../../editor/types';
import { transcribePath } from '../../transcript/assemblyai';
import { fillerIndices } from '../../transcript/edit';
import { translateLines } from '../../captions/translate';
import { createVariant, findVariantByLang, upsertVariant } from '../../transcript/variants';
import { buildSilenceGapCaps, parseCleanOnly, parseSilenceRule, type SilenceRule } from '../../transcript/clean';
import type { Action } from '../../editor/reduce';
import { execFindTranscript, findPhrase, normalize } from './transcript-find';

// Agent tools for the transcript / caption / "delete text = delete video" surface.
// Names + semantics: transcribe (import_media/manage_transcript),
// find_transcript, clean_script, delete_text (apply_script), edit_captions.

export const TRANSCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'transcribe_track',
    description: 'Transcribe the audio clip on a track (word-level + speaker labels, via AssemblyAI) and attach the transcript. Required before find_transcript / clean_script / delete_text / captions when the clip has no transcript yet.',
    input_schema: { type: 'object', properties: { track: { type: 'string', description: 'Track alias or stable id whose audio to transcribe (default A1).' } } },
  },
  {
    name: 'find_transcript',
    description: 'Find WHEN a phrase is spoken — a time-coordinate lookup, not a transcript reader or editing tool. Returns matches with their timeline frame range (fromFrame/toFrame) so you can anchor B-roll, motion graphics, markers, or overlays at that moment (or locate a spot before delete_text). Default: contiguous case/punctuation/whitespace-insensitive match over every transcribed clip on the timeline; edits are respected (deleted words won\'t match). asset = search ONE asset\'s raw transcript regardless of timeline use (library lookup, ignores edits). track = restrict to that track. fuzzy = token-order match with window tolerance (use when ASR may have fillers like "uh," between query tokens). includeWordTimestamps = add a Words block under each match with each word\'s start → end time — use when syncing animation beats to which word is being said; skip for plain phrase anchoring (extra output). limit = max results (default 10).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        asset: { type: 'string', description: 'Asset ID or prefix ID. Omit to search across the whole project.' },
        track: { type: 'string', description: 'Track alias (V1/A1/...) or track id. Restricts the search to that track.' },
        fuzzy: { type: 'boolean', description: 'Token-window match (tolerates fillers between tokens).' },
        includeWordTimestamps: { type: 'boolean', description: 'Include per-word timestamps inside each match (default false). Adds a Words block under each match with each word\'s start -> end time. Use when syncing animation beats to speech cadence (e.g., MG internal rhythm matched to which word is being said).' },
        limit: { type: 'integer', description: 'Max results returned (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'clean_script',
    description: 'Mechanically clean transcribed clips with fixed filler removal and typed pause rules. only may be "fillers", "silence", or "fillers,silence". silence accepts compress:400, restore:500, normalize:500, range:300-800, plus legacy max:400, min:500, 500, and min:300,max:800. Rules that lengthen a pause never exceed the silence present in the recording. Existing maxPauseSeconds/removeFillers calls remain supported. The whole operation is one undo step.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track alias/id whose voiceover clips to clean (default A1). Cleans every transcribed clip on it.' },
        itemId: { type: 'string', description: 'Optional: clean only this one clip instead of the whole track.' },
        only: { type: 'string', description: 'Run fillers, silence, or both as fillers,silence. Omit for existing default behavior.' },
        silence: { type: 'string', description: 'Pause rule: compress:400, restore:500, normalize:500, range:300-800, or legacy syntax.' },
        longSilence: { type: 'number', description: 'Long-pause threshold in ms for the default silence rule (pauses at/above it compress to 200ms). Default 3000 when only includes silence and no silence rule is supplied.' },
        maxPauseSeconds: { type: 'number', description: 'Compress pauses longer than this down to it (e.g. 0.5). Omit to leave pauses.' },
        removeFillers: { type: 'boolean', description: 'Strip filler words (default true).' },
      },
    },
  },
  {
    name: 'edit_gap',
    description:
      'List or edit breath/silence gaps between spoken words on a transcribed clip. Gaps are computed from word timestamps (next.start − prev.end), not separate assets. action=list returns visible gaps with afterWordIndex/gapSeconds/context. action=delete removes one gap (silence→0, later audio ripples earlier). action=cap compresses one gap to maxSeconds (e.g. 0.2). action=restore clears a per-gap override so the original pause returns. Prefer list first to get afterWordIndex. For batch whole-track pause cleanup use clean_script instead.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'delete', 'cap', 'restore'],
          description: 'list=enumerate gaps; delete=remove one gap; cap=compress one gap; restore=undo per-gap override.',
        },
        track: { type: 'string', description: 'Track alias/id (default A1) when itemId omitted.' },
        itemId: { type: 'string', description: 'Target clip id (prefix ok). Prefer when multiple clips share a track.' },
        afterWordIndex: {
          type: 'number',
          description: 'Word index AFTER the gap (from list). Required for delete/cap/restore unless afterText is given.',
        },
        afterText: {
          type: 'string',
          description: 'Locate gap by the spoken phrase that STARTS after the gap (matched in transcript). Alternative to afterWordIndex.',
        },
        gapIndex: {
          type: 'number',
          description: '0-based index among listable gaps on the clip (from list). Alternative to afterWordIndex.',
        },
        maxSeconds: {
          type: 'number',
          description: 'cap only: max pause seconds to keep (e.g. 0.2 or 0.5). Required for cap.',
        },
        minGapSeconds: {
          type: 'number',
          description: 'list only: min raw gap to include (default 0.25s).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'delete_text',
    description: 'Delete a spoken phrase from a track — "delete text = delete video": the matching words\' audio and their time are cut and the clip re-times. If unsure of the exact wording, find_transcript first. ⚠ AUDIO clips only re-time this way; a VIDEO clip always plays continuously from srcInFrame — deleting its words cuts NOTHING (captions keep mirroring the audible speech, so the deletion has no visible effect). To cut a video clip use split_item / edit_item (srcInFrame + durationInFrames); to hide individual words from captions use edit_captions action=display_text.',
    input_schema: { type: 'object', properties: { track: { type: 'string' }, query: { type: 'string', description: 'The phrase to delete (matched against the transcript).' } }, required: ['query'] },
  },
  {
    name: 'manage_transcript',
    description: '管理源转写的修正与翻译变体,不改时间轴(词的起止/帧位/词数/片段时长恒不变)。action(6 个):\n'
      + '- fix：修正源转写。改错字→传 wordIndex 或 find(错词原文)+ text(正确文本),只改 word.text;改/合并说话人→传 from(现有标签,如 "A")+ to(新显示名,传已有标签即合并两位),只改 word.speaker。\n'
      + '- retry_transcription：对该 clip 强制重跑 ASR(转写卡住/失败/想重转时),覆盖现有转写。\n'
      + '- translation_create：把该转写整段翻成 lang,新建/覆盖一个译文变体(词级,共享源时间轴)。\n'
      + '- translation_ensure：幂等——同 lang 变体已存在则复用,否则翻译新建。日常「翻译一下」优先用它。\n'
      + '- translation_list：列出该 clip 的原文 + 所有译文变体(id/lang/词数)。\n'
      + '- translation_read：读某个译文变体的词(传 lang / targetLanguage 选语言)。\n'
      + '译文变体只承载译文;要在字幕里显示某语言,用 edit_captions 的 language_mode。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['fix', 'retry_transcription', 'translation_create', 'translation_ensure', 'translation_list', 'translation_read'], description: '见描述:改错字/说话人、重转、建/保证/列/读译文变体。' },
        itemId: { type: 'string', description: '目标 clip 的 item id;省略则取该 track 上第一个带转写的音/视频 clip。' },
        track: { type: 'string', description: 'itemId 省略时,用 track 别名/稳定 id 定位(默认 A1)。' },
        wordIndex: { type: 'number', description: 'fix 改错字:要修正的词下标(与 find 二选一)。' },
        find: { type: 'string', description: 'fix 改错字:错词原文,精确匹配一个词(与 wordIndex 二选一)。' },
        text: { type: 'string', description: 'fix 改错字:修正后的正确文本。' },
        from: { type: 'string', description: 'fix 改说话人:要重命名的现有说话人标签(如 "A"/"B")。' },
        to: { type: 'string', description: 'fix 改说话人:新显示名;传一个已存在的标签即合并两位说话人(如 "B"→"A")。' },
        lang: { type: 'string', description: 'translation_create/ensure:目标语言(如 "English"/"中文"/"日本語");translation_read:要读的变体语言。' },
        targetLanguage: { type: 'string', description: 'translation_read:要读的译文语言(lang 的别名)。' },
      },
      required: ['action'],
    },
  },
];

export const TRANSCRIPT_TOOL_NAMES = new Set(TRANSCRIPT_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

// normalize / findPhrase live in transcript-find.ts (shared with the find_transcript
// executor and manage_markers' transcriptSegments anchoring).

// audio clip on a track, optionally requiring an attached transcript
function trackClip(ctx: AgentContext, track: TrackId, needTranscript: boolean): TimelineItem | null {
  return ctx.getState().items.find((it) =>
    (it.kind === 'audio' || it.kind === 'video') && it.track === track && it.src && (!needTranscript || (it.transcript?.length ?? 0) > 0)) ?? null;
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

// manage_transcript has six actions (fix / retry_transcription /
// translation_create / translation_ensure / translation_list / translation_read).
// All actions preserve word timing, frame position, count, and clip length;
// only word .text / .speaker or a translation VARIANT change.
async function manageTranscript(args: Args, ctx: AgentContext, track: TrackId, alias: string): Promise<unknown> {
  const action = String(args.action ?? '');
  const it = args.itemId ? ctx.getState().items.find((x) => x.id === args.itemId) : trackClip(ctx, track, true);
  if (!it) return { error: args.itemId ? `no item ${String(args.itemId)}` : `no transcribed clip on ${alias}; call transcribe_track first` };

  // retry_transcription: force a fresh ASR run (the only action that doesn't need an existing transcript).
  if (action === 'retry_transcription') {
    if (!it.src) return { error: `item ${it.id} has no media to transcribe` };
    try {
      const r = await transcribePath(it.src, undefined, { languageCode: 'zh' });
      ctx.commands.setItemTranscript(it.id, r.words);
      return { ok: true, action, itemId: it.id, words: r.words.length, text: r.text.slice(0, 200), retried: true };
    } catch (e) {
      return { error: `transcription failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (!it.transcript?.length) return { error: `item ${it.id} has no transcript; call transcribe_track first` };

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

  return { error: `unsupported action "${action}"; use fix / retry_transcription / translation_create / translation_ensure / translation_list / translation_read` };
}

// Execute a transcript/caption tool. Returns undefined if `name` isn't one of ours.
export async function execTranscriptTool(name: string, args: Args, ctx: AgentContext): Promise<unknown | undefined> {
  const state = ctx.getState();
  const track = resolveTrackId(state, args.track ?? 'A1') ?? defaultTrackId(state, 'audio');
  if (!track) return { error: 'no track available; create one with edit_track first' };
  const alias = trackAlias(state, track);
  switch (name) {
    case 'transcribe_track': {
      // Transcribe ALL audio/video clips on the track (not just the first).
      const clips = ctx.getState().items
        .filter((it) => (it.kind === 'audio' || it.kind === 'video') && it.track === track && it.src)
        .sort((a, b) => a.startFrame - b.startFrame);
      if (!clips.length) return { error: `no audio/video clip on ${alias}` };
      const results: { itemId: string; words: number; text: string; skipped?: boolean }[] = [];
      try {
        for (const it of clips) {
          if (it.transcript?.length) {
            results.push({ itemId: it.id, words: it.transcript.length, text: '', skipped: true });
            continue;
          }
          const r = await transcribePath(it.src!, undefined, { languageCode: 'zh' });
          ctx.commands.setItemTranscript(it.id, r.words);
          results.push({ itemId: it.id, words: r.words.length, text: r.text.slice(0, 200) });
        }
        return { ok: true, track: alias, clips: results.length, results };
      } catch (e) {
        return { error: `transcription failed: ${e instanceof Error ? e.message : String(e)}`, partial: results };
      }
    }
    case 'find_transcript':
      // 参数面(asset/fuzzy/includeWordTimestamps/limit)+ 全工程搜索:transcript-find.ts。
      return execFindTranscript(args, ctx);
    case 'clean_script': {
      // Whole-track batch: clean every
      // transcribed clip on the track, not just the first. itemId narrows to one clip.
      const targetId = typeof args.itemId === 'string' ? args.itemId : '';
      const clips = targetId
        ? state.items.filter((x) => (x.id === targetId || x.id.startsWith(targetId)) && (x.transcript?.length ?? 0) > 0)
        : state.items.filter((x) => x.track === track && (x.transcript?.length ?? 0) > 0);
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
          });
        } else if (!usesTypedArgs) {
          actions.push({ type: 'cleanScript', id: it.id, silenceFrames, removeFillers });
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
      if (!it?.transcript?.length) {
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
      if (!it?.transcript) return { error: `no transcript on ${alias}; call transcribe_track first` };
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
