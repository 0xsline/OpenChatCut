import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { ASPECT_PRESETS, type AspectPreset, type TimelineItem } from '../../editor/types';
import { msToFrame, type TranscriptWord } from '../../transcript/types';
import { generateAgentText } from '../client';

// find_highlights - intelligent slicing/converting long to short into slices.
//
// "clip/highlight extraction / cut slices / make a short version" is essentially transliteration editing
// Workflow (the semantics of which words determine what to broadcast), rather than an atomic command. Implementation path: LLM reading, conversion and scoring →
// Batch short video sequences. Therefore:
//   · The tool name is find_highlights;
//   · The highlight judgment standard reuses the rules of talking-head-guide (see SELECT_SYSTEM);
//   · Long to short reuse of existing infrastructure duplicateTimeline({retarget}) + ASPECT_PRESETS(with
//     timeline-tools.ts long to short is exactly the same path), no additional relocation is required;
//   · When cutting to the highlight frame interval, rewrite the clip as "delete text = delete video" (deleteWords) to keep the word frame consistent.
//     Non-transcribed clip goes frame level setItemTiming/removeItem.

type Args = Record<string, unknown>;

/** LLM A highlighted section:a continuous range of words(Contains endpoints)+ Title/Reason. */
export interface Highlight {
  startWordIndex: number;
  endWordIndex: number;
  title: string;
  reason?: string;
}

/** issued to LLM compact entry for(Index alignment original transcription subscript,Cannot be cut otherwise it will be misaligned)。 */
interface WordRef {
  i: number;
  t: string;
  start: number; // ms
  end: number; // ms
}

interface SelectOpts {
  count: number;
  topic?: string;
  instruction?: string;
}

export const HIGHLIGHT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'find_highlights',
    description:
      'Smart slicing(Long story short film):Read the word-for-word transcript of the transcribed video on the timeline,by LLM Pick out the most exciting highlight clips that can stand on their own,Each segment is copied into a vertical screen short video sequence.(Default 9:16)And crop to the frame interval of the highlight. Fragments need to be transcribed first(transcribe_track). Return the sequence of each short video id/Title/frame interval.LLM Fallback heuristic on failure(information density chunking)。',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: 'The number of short videos to generate(Default 3)。' },
        ratio: { type: 'string', enum: ['9:16', '16:9', '1:1', '4:3', '3:4'], description: 'Short video canvas ratio(Default 9:16)。' },
        topic: { type: 'string', description: 'Optional:Pick only highlights that are relevant to the topic.' },
        instruction: { type: 'string', description: 'Optional:Additional selection preferences(Such as"The most emotionally conflicted""with data points")。' },
        itemId: { type: 'string', description: 'Optional:Specify transcribed video/audio clip(The one with the most default words)。' },
        minSeconds: { type: 'number', description: 'Minimum seconds per segment(Default 3)。' },
        maxSeconds: { type: 'number', description: 'Maximum number of seconds per segment(Default 60)。' },
      },
    },
  },
];

export const HIGHLIGHT_TOOL_NAMES = new Set(HIGHLIGHT_TOOL_SCHEMAS.map((t) => t.name));

// Highlight criteria - talking-head-guide.md rules.
const SELECT_SYSTEM = `You are a short video editor,From the word-for-word transcription of a spoken word, select the highlight clips that are most suitable for making into a stand-alone vertical short video.
Determine highlights:Opinion, Conclusion, Story, Emotion, Conflict, Tutorial Steps, Data Points,or a specific topic.
- Each highlight must be understood independently:Keep the subject, foreshadowing, questions and conclusions needed to understand it,Don't cut out the context.
- If a short and powerful sentence is valid, it depends on the surrounding context.,Keep even the context,Don’t leave it at that.
- If the user specifies a topic,Just pick this topic;To"The most exciting",Prioritize information density and expression.
- Each paragraph is a continuous paragraph of words(startWordIndex..endWordIndex,Contains endpoints),There must be no overlap between clips.
Only output strict JSON array(Don't explain, don't markdown fence):
[{"startWordIndex":integer,"endWordIndex":integer,"title":"short title","reason":"why wonderful"}]`;

// ── LLM selection (can be replaced by setHighlightSelector with stub for offline self-test)──────────────
type HighlightSelector = (words: WordRef[], opts: SelectOpts) => Promise<unknown>;

/** production path:true tune LLM,Returns the parsed original array(Not verified,regarded as untrustworthy)。 */
async function llmSelectHighlights(words: WordRef[], opts: SelectOpts): Promise<unknown> {
  const list = words.map((w) => `${w.i}:${w.t}`).join(' ');
  const bias = [
    opts.topic ? `Just pick the topic "${opts.topic}” related fragments.` : '',
    opts.instruction ? `additional preferences:${opts.instruction}` : '',
  ].join('');
  const user = `word-for-word transcription(total ${words.length} word,Format serial number:word):\n${list}\n\nPick out the most ${opts.count} Highlight section.${bias}`;
  const text = (await generateAgentText({
    maxOutputTokens: 8192,
    system: SELECT_SYSTEM,
    prompt: user,
  })).trim();
  return parseJsonArray(text);
}

let selector: HighlightSelector = llmSelectHighlights;
/** only .check use:Inject offline excerpts stub;pass null Restore the truth LLM path. */
export function setHighlightSelector(fn: HighlightSelector | null): void {
  selector = fn ?? llmSelectHighlights;
}

/** Extract the first one from the model text JSON Array and parse;Throw an error on failure(Transfer it to the upper level error)。 */
function parseJsonArray(text: string): unknown {
  const cleaned = text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('Not included in model output JSON array');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export interface ValidateHighlightOpts {
  max: number;
  /** Word-level duration filter using transcript ms (inclusive indices). */
  words?: Array<{ start: number; end: number }>;
  minMs?: number;
  maxMs?: number;
}

/**
 * Check and clean LLM output(Not trustworthy):discard non-integers/Cross the line/start>end entry,Sort by starting point and remove overlap
 * (Overlapping segments only retain the one that appears first),Take the most max segment. Optional filtering by duration. Export for direct single testing to reject out of bounds/overlap.
 */
export function validateHighlights(
  raw: unknown,
  wordCount: number,
  maxOrOpts: number | ValidateHighlightOpts,
): Highlight[] {
  const opts: ValidateHighlightOpts = typeof maxOrOpts === 'number'
    ? { max: maxOrOpts }
    : maxOrOpts;
  const max = opts.max;
  if (!Array.isArray(raw)) return [];
  const cleaned: Highlight[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const s = o.startWordIndex;
    const en = o.endWordIndex;
    if (!Number.isInteger(s) || !Number.isInteger(en)) continue;
    const si = s as number;
    const ei = en as number;
    if (si < 0 || ei < 0 || si >= wordCount || ei >= wordCount || si > ei) continue;
    if (opts.words && (opts.minMs != null || opts.maxMs != null)) {
      const startMs = opts.words[si]?.start ?? 0;
      const endMs = opts.words[ei]?.end ?? startMs;
      const dur = Math.max(0, endMs - startMs);
      if (opts.minMs != null && dur < opts.minMs) continue;
      if (opts.maxMs != null && dur > opts.maxMs) {
        // Shrink end index until under maxMs (keep start).
        let e2 = ei;
        while (e2 > si && (opts.words[e2].end - startMs) > opts.maxMs) e2 -= 1;
        if ((opts.words[e2].end - startMs) < (opts.minMs ?? 0)) continue;
        const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `Highlights ${cleaned.length + 1}`;
        cleaned.push({
          startWordIndex: si,
          endWordIndex: e2,
          title,
          reason: typeof o.reason === 'string' ? o.reason : undefined,
        });
        continue;
      }
    }
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `Highlights ${cleaned.length + 1}`;
    cleaned.push({ startWordIndex: si, endWordIndex: ei, title, reason: typeof o.reason === 'string' ? o.reason : undefined });
  }
  cleaned.sort((a, b) => a.startWordIndex - b.startWordIndex || a.endWordIndex - b.endWordIndex);
  const out: Highlight[] = [];
  let lastEnd = -1;
  for (const h of cleaned) {
    if (h.startWordIndex <= lastEnd) continue; // Overlaps with reserved interval → discard
    out.push(h);
    lastEnd = h.endWordIndex;
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Heuristic fallback when LLM is unavailable: split transcript into non-overlapping
 * windows by information density (chars / second) and take top-N.
 */
export function heuristicHighlights(
  words: WordRef[],
  count: number,
  minMs = 3000,
  maxMs = 60_000,
): Highlight[] {
  if (!words.length || count <= 0) return [];
  const totalMs = Math.max(1, words[words.length - 1].end - words[0].start);
  const windowMs = Math.min(maxMs, Math.max(minMs, Math.round(totalMs / Math.max(count, 1))));
  const candidates: Array<Highlight & { score: number }> = [];
  let i = 0;
  while (i < words.length) {
    const startMs = words[i].start;
    let j = i;
    while (j + 1 < words.length && words[j + 1].end - startMs <= windowMs) j += 1;
    const endMs = words[j].end;
    const dur = Math.max(1, endMs - startMs);
    if (dur >= minMs * 0.8) {
      const text = words.slice(i, j + 1).map((w) => w.t).join('');
      // Density + mild bonus for longer intact phrases / punctuation energy
      const score = (text.length / (dur / 1000))
        + ( /[?!？！]/.test(text) ? 8 : 0)
        + ( /\d/.test(text) ? 4 : 0);
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 24) || `fragment ${candidates.length + 1}`;
      candidates.push({
        startWordIndex: i,
        endWordIndex: j,
        title,
        reason: 'heuristic density',
        score,
      });
    }
    // Advance with slight overlap avoid: jump past mid window
    const mid = Math.max(i + 1, Math.floor((i + j) / 2) + 1);
    i = j >= i ? Math.max(j + 1, mid) : i + 1;
  }
  candidates.sort((a, b) => b.score - a.score);
  // Re-sort by time and de-overlap greedily by score order
  const picked: Highlight[] = [];
  const used = new Array(words.length).fill(false);
  for (const c of candidates) {
    let overlap = false;
    for (let k = c.startWordIndex; k <= c.endWordIndex; k++) {
      if (used[k]) { overlap = true; break; }
    }
    if (overlap) continue;
    for (let k = c.startWordIndex; k <= c.endWordIndex; k++) used[k] = true;
    picked.push({
      startWordIndex: c.startWordIndex,
      endWordIndex: c.endWordIndex,
      title: c.title,
      reason: c.reason,
    });
    if (picked.length >= count) break;
  }
  picked.sort((a, b) => a.startWordIndex - b.startWordIndex);
  return picked;
}

/** timeline"main content":with transcribed sounds/video clip The one with the most words(Video priority)。 */
function pickTranscribedItem(items: TimelineItem[], itemId?: string): TimelineItem | null {
  if (itemId) {
    const q = itemId;
    const hit = items.find((it) => (it.id === q || it.id.startsWith(q))
      && (it.kind === 'video' || it.kind === 'audio')
      && (it.transcript?.length ?? 0) > 0);
    if (hit) return hit;
  }
  const scored = items
    .filter((it) => (it.kind === 'video' || it.kind === 'audio') && (it.transcript?.length ?? 0) > 0)
    .map((it) => ({ it, score: (it.transcript!.length) + (it.kind === 'video' ? 100000 : 0) }));
  if (!scored.length) return null;
  return scored.reduce((best, cur) => (cur.score > best.score ? cur : best)).it;
}

export interface Short {
  timelineId: string;
  title: string;
  startFrame: number;
  endFrame: number;
  ratio: string;
}

/**
 * Turn each highlight into a short video sequence:Copy the original sequence and relocate it to the target canvas,Cut to the highlight frame interval.
 * Transcribe clip go deleteWords To keep the word frame consistent, the rest clip Perform frame-level cropping. Return to the completed short video list.
 */
export function assembleShorts(
  ctx: AgentContext,
  srcTimelineId: string,
  item: TimelineItem,
  highlights: Highlight[],
  preset: AspectPreset,
): Short[] {
  const words = item.transcript!;
  const fps = ctx.getState().fps;
  const shorts: Short[] = [];
  for (const hl of highlights) {
    const spanStart = item.startFrame + msToFrame(words[hl.startWordIndex].start, fps);
    const rawEnd = item.startFrame + msToFrame(words[hl.endWordIndex].end, fps);
    const spanEnd = Math.max(rawEnd, spanStart + 1); // at least 1 frame
    const copyId = ctx.commands.duplicateTimeline(srcTimelineId, {
      name: hl.title,
      retarget: { width: preset.width, height: preset.height, fit: 'cover' },
      activate: false,
    });
    ctx.commands.switchTimeline(copyId); // The clip-by-clip command only works on the active sequence → cut to the copy first
    trimCopyToHighlight(ctx, item.id, words.length, hl, spanStart, spanEnd);
    shorts.push({ timelineId: copyId, title: hl.title, startFrame: spanStart, endFrame: spanEnd, ratio: preset.label });
  }
  return shorts;
}

/** at present active on copy,put [spanStart,spanEnd) All other content will be cut off,and translate the interval to 0。 */
function trimCopyToHighlight(
  ctx: AgentContext,
  transcribedId: string,
  wordCount: number,
  hl: Highlight,
  spanStart: number,
  spanEnd: number,
): void {
  const snapshot = [...ctx.getState().items]; // Snapshot first: subsequent editing does not change the absolute frame bits of other clips

  // 1) Transcribe clip: delete words other than highlights ("delete text = delete video", word ↔ frame consistency is guaranteed by this mechanism),
  //    The reserved words are played in order, and then the whole pan is moved to frame 0 so that the short video starts from the highlight.
  const outside: number[] = [];
  for (let i = 0; i < wordCount; i++) if (i < hl.startWordIndex || i > hl.endWordIndex) outside.push(i);
  if (outside.length) ctx.commands.deleteWords(transcribedId, outside);
  ctx.commands.moveItem(transcribedId, { startFrame: 0 });

  // 2) The rest of the clips: intersect with [spanStart,spanEnd) - delete without overlap, crop with overlap and translate -spanStart.
  for (const it of snapshot) {
    if (it.id === transcribedId) continue;
    const itemEnd = it.startFrame + it.durationInFrames;
    const oStart = Math.max(it.startFrame, spanStart);
    const oEnd = Math.min(itemEnd, spanEnd);
    if (oEnd <= oStart) {
      ctx.commands.removeItem(it.id);
      continue;
    }
    const leftTrim = oStart - it.startFrame;
    // Active media (video/audio) left clipping needs to be advanced srcInFrame simultaneously; MG/text is passive, and the timeline animation follows the starting point.
    // ponytail: MG will lose the opening animation if its head is cropped, so short video scenes are acceptable.
    ctx.commands.setItemTiming(it.id, {
      startFrame: oStart - spanStart,
      durationInFrames: oEnd - oStart,
      srcInFrame: it.src ? (it.srcInFrame ?? 0) + leftTrim : undefined,
    });
  }
}

export async function execHighlightTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'find_highlights') return { error: `unknown tool ${name}` };

  const doc = ctx.getDoc();
  const originalActiveId = doc.activeTimelineId;
  const srcTimelineId = originalActiveId;

  const item = pickTranscribedItem(
    ctx.getState().items,
    typeof args.itemId === 'string' ? args.itemId : undefined,
  );
  if (!item?.transcript?.length) {
    return { error: 'There are no transcribed videos in the current timeline/audio clip;Please use it first transcribe_track Transcribe,Smart slicing.' };
  }

  const ratio = typeof args.ratio === 'string' ? args.ratio : '9:16';
  const preset = ASPECT_PRESETS.find((p) => p.label === ratio);
  if (!preset) return { error: `unknown ratio ${ratio}(Optional ${ASPECT_PRESETS.map((p) => p.label).join('/')})` };
  const count = Number.isInteger(args.count) && (args.count as number) > 0 ? (args.count as number) : 3;
  // Duration bounds only when caller opts in (default leaves short LLM picks intact).
  const hasMin = Number.isFinite(Number(args.minSeconds));
  const hasMax = Number.isFinite(Number(args.maxSeconds));
  const minSeconds = hasMin ? Math.max(0.5, Number(args.minSeconds)) : undefined;
  const maxSeconds = hasMax
    ? Math.max(minSeconds ?? 0.5, Number(args.maxSeconds))
    : undefined;
  const minMs = minSeconds != null ? Math.round(minSeconds * 1000) : undefined;
  const maxMs = maxSeconds != null ? Math.round(maxSeconds * 1000) : undefined;

  const words: WordRef[] = item.transcript.map((w: TranscriptWord, i) => ({ i, t: w.text, start: w.start, end: w.end }));

  let raw: unknown;
  let source: 'llm' | 'heuristic' = 'llm';
  try {
    raw = await selector(words, {
      count,
      topic: typeof args.topic === 'string' ? args.topic : undefined,
      instruction: typeof args.instruction === 'string' ? args.instruction : undefined,
    });
  } catch {
    raw = null;
  }

  let highlights = validateHighlights(raw, words.length, {
    max: count,
    words: (minMs != null || maxMs != null) ? words : undefined,
    minMs,
    maxMs,
  });
  if (!highlights.length) {
    source = 'heuristic';
    highlights = heuristicHighlights(
      words,
      count,
      minMs ?? 1000,
      maxMs ?? 60_000,
    );
  }
  if (!highlights.length) {
    ctx.commands.switchTimeline(originalActiveId);
    return { error: 'Unable to select available highlight clips from transcription(Model output is empty and the heuristic has no candidates)。' };
  }

  const shorts = assembleShorts(ctx, srcTimelineId, item, highlights, preset);
  ctx.commands.switchTimeline(originalActiveId); // Restore the user view to the original sequence (duplicate with activate:false)

  return {
    ok: true,
    sourceItemId: item.id,
    count: shorts.length,
    shorts,
    selector: source,
    ...(minSeconds != null || maxSeconds != null
      ? { durationBounds: { minSeconds: minSeconds ?? null, maxSeconds: maxSeconds ?? null } }
      : {}),
  };
}
