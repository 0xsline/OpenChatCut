import { msToFrame, type TranscriptWord, type TranscriptVariant } from './types';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../editor/sourceLimit';

// Transcript-based editing: deleting a word removes its audible source range.
// The kept audio = maximal runs of NON-deleted words, each run playing the
// source span [firstWord.start, lastWord.end], concatenated back-to-back (so a
// middle deletion ripples the tail earlier). This is the "delete text = delete
// video" model. Silence compression additionally caps the gap between kept
// words (long pauses shrink to the target; short pauses play as-is).

export interface KeptSegment {
  srcStartFrame: number; // trim point in the source
  srcEndFrame: number;
  fromFrame: number; // position on the timeline
  durFrames: number;
}

export interface EditOpts {
  /** compress inter-word silences longer than this (frames) down to it;
   * undefined = keep every pause at its recorded length. */
  maxGapFrames?: number;
  /**
   * Per-boundary silence caps (ms). Key = word index AFTER the gap.
   * When set for a boundary, overrides maxGapFrames for that boundary only.
   * 0 ms = delete the gap (Gap row trash button).
   */
  gapCapsMs?: Record<string, number>;
  /** Source word indices in playback order (speech-block drag). */
  playOrder?: number[];
  /**
   * The breathing port budget reserved on both sides of the tangent point (frame, divided equally on both sides). If the cut falls right on the word boundary, the consonants will be cut off.
   * The onset and ending sound "glued together"; here is the **cut caused by word deletion/rearrangement**, from what originally existed
   * Each person in Shizune can borrow up to half. If you can’t borrow that much, you can borrow as much as you like.
   *
   * Only applies to cuts: the beginning and end of the fragment itself and the gaps covered by gapCapsMs/maxGapFrames are not added.
   * (The length of those gaps is already dictated by the compression rules). undefined/0 = old behavior, cut exactly at word boundaries.
   */
  cutPadFrames?: number;
  /**
   * Visible window over the EDITED (kept) stream, in edited-local frames —
   * the trim handles' [srcInFrame, srcInFrame+durationInFrames) slice. Segments
   * outside are dropped, boundary segments clipped, survivors re-packed from
   * offsetFrames. Undefined = whole stream (pre-window behavior, byte-identical).
   * Fix the soft points of "trim transcribe clip, change the frame but not the words": render/caption/find all go through this gate.
   */
  window?: { startFrame: number; durFrames: number };
}


/** The window an item's trim fields describe. ONLY audio clips render word-driven
 * (AudioClip keptSegments) — a video item's srcInFrame is MEDIA frames feeding its
 * continuous render (OffthreadVideo trimBefore), a different coordinate space, so
 * non-audio returns undefined (= whole stream, pre-window behavior). */
export function itemWindow(it: { kind: string; srcInFrame?: number; durationInFrames: number }): EditOpts['window'] {
  if (it.kind !== 'audio') return undefined;
  return { startFrame: it.srcInFrame ?? 0, durFrames: it.durationInFrames };
}

/**
 * The current editing parameters of a clip. Rendering, export, captions, and find_transcript must all use the same copy, otherwise
 * Adding a switch will only take effect on half of the paths, and playback and export will have their own issues. `window` is not here: some calls
 * It requires the entire word stream (total length), and some only require visible fragments, and the caller can fill in `itemWindow(item)` as needed.
 */
export function itemEditOpts(it: {
  silenceFrames?: number;
  gapCapsMs?: Record<string, number>;
  transcriptPlayOrder?: number[];
  cutPadFrames?: number;
}): EditOpts {
  return {
    maxGapFrames: it.silenceFrames,
    gapCapsMs: it.gapCapsMs,
    playOrder: it.transcriptPlayOrder,
    cutPadFrames: it.cutPadFrames,
  };
}

/** Max frames allowed for the gap immediately before `nextWordIdx` (null = uncapped). */
export function gapCapFrames(opts: EditOpts, nextWordIdx: number, fps: number): number | null {
  const key = String(nextWordIdx);
  if (opts.gapCapsMs && Object.prototype.hasOwnProperty.call(opts.gapCapsMs, key)) {
    const ms = opts.gapCapsMs[key]!;
    return Math.max(0, Math.round((ms / 1000) * fps));
  }
  if (opts.maxGapFrames != null) return opts.maxGapFrames;
  return null;
}

export function keptSegments(
  words: TranscriptWord[],
  deleted: Set<number>,
  fps: number,
  offsetFrames: number,
  opts: EditOpts = {},
): KeptSegment[] {
  // Play order: custom (speech-block drag) or chronological, skip deleted.
  const seq = (
    opts.playOrder?.length
      ? opts.playOrder
      : words.map((_, i) => i)
  ).filter((i) => i >= 0 && i < words.length && !deleted.has(i));

  const half = Math.max(0, Math.floor((opts.cutPadFrames ?? 0) / 2));

  const segs: KeptSegment[] = [];
  let pos = offsetFrames;
  let si = 0;
  while (si < seq.length) {
    const wi = seq[si]!;
    let srcStart = msToFrame(words[wi]!.start, fps);
    let srcEnd = msToFrame(words[wi]!.end, fps);
    let sj = si;
    let curWi = wi; // last source word merged into this run
    let capped = false; // This paragraph is truncated by the silence compression rule (rather than cut by word deletion)
    // Merge forward ONLY through immediate chronological successors. A jump in
    // source index — deleted words sitting between (delete words = delete video) or a play-order
    // reorder — ends the run, so the skipped source span is dropped instead of
    // being played through; deleting words must shorten the corresponding frames.
    while (sj + 1 < seq.length) {
      const nextWi = seq[sj + 1]!;
      if (nextWi !== curWi + 1) break; // deleted-word gap or reorder jump → new segment
      const nextStart = msToFrame(words[nextWi]!.start, fps);
      const gap = nextStart - srcEnd;
      if (gap < 0) break; // overlap / reverse → new segment
      const cap = gapCapFrames(opts, nextWi, fps);
      if (cap != null && gap > cap) {
        srcEnd += cap; // keep only the allowed trailing silence
        capped = true;
        break;
      }
      srcEnd = msToFrame(words[nextWi]!.end, fps);
      curWi = nextWi;
      sj += 1;
    }
    // Breathing port: Each side of the cutout borrows up to half frames from the original silence. The beginning and end of the fragment itself are not borrowed (that is not
    // cut out), the gap pressed by cap will not be borrowed (the length has been determined by the compression rules).
    if (half > 0) {
      if (wi > 0 && (si === 0 ? true : seq[si - 1] !== wi - 1)) {
        const silence = srcStart - msToFrame(words[wi - 1]!.end, fps);
        srcStart = Math.max(0, srcStart - Math.max(0, Math.min(silence, half)));
      }
      if (!capped && curWi + 1 < words.length && seq[sj + 1] !== curWi + 1) {
        const silence = msToFrame(words[curWi + 1]!.start, fps) - srcEnd;
        srcEnd += Math.max(0, Math.min(silence, half));
      }
    }
    const durFrames = Math.max(1, srcEnd - srcStart);
    segs.push({ srcStartFrame: srcStart, srcEndFrame: srcEnd, fromFrame: pos, durFrames });
    pos += durFrames;
    si = sj + 1;
  }
  return opts.window ? windowSegments(segs, offsetFrames, opts.window) : segs;
}

// Clip packed segments to the visible window (edited-local frames), re-packing
// survivors so playback starts at offsetFrames again. Head/tail cuts translate
// 1:1 into source-frame adjustments (a segment is a contiguous source span).
function windowSegments(
  segs: KeptSegment[],
  offsetFrames: number,
  window: NonNullable<EditOpts['window']>,
): KeptSegment[] {
  const w0 = Math.max(0, window.startFrame);
  const w1 = w0 + Math.max(0, window.durFrames);
  const out: KeptSegment[] = [];
  let pos = offsetFrames;
  for (const seg of segs) {
    const local0 = seg.fromFrame - offsetFrames;
    const local1 = local0 + seg.durFrames;
    const a = Math.max(local0, w0);
    const b = Math.min(local1, w1);
    if (b <= a) continue;
    const headCut = a - local0;
    const tailCut = local1 - b;
    out.push({
      srcStartFrame: seg.srcStartFrame + headCut,
      srcEndFrame: seg.srcEndFrame - tailCut,
      fromFrame: pos,
      durFrames: b - a,
    });
    pos += b - a;
  }
  return out;
}

/** Exact edited-stream length. Unlike editedFrames, an unusable word stream stays 0. */
export function editedStreamFrames(words: TranscriptWord[], deleted: Set<number>, fps: number, opts: EditOpts = {}): number {
  return keptSegments(words, deleted, fps, 0, opts).reduce((s, seg) => s + seg.durFrames, 0);
}

// Edited clip length in frames, min 1 for timeline item duration invariants.
export function editedFrames(words: TranscriptWord[], deleted: Set<number>, fps: number, opts: EditOpts = {}): number {
  return Math.max(1, editedStreamFrames(words, deleted, fps, opts));
}

interface RetimedWordEntry {
  index: number;
  word: TranscriptWord;
}

// Core projection shared by retimeWords/keptWordIndices: surviving words with
// their SOURCE indices, in final TIMELINE order (sorted by projected start,
// then de-overlapped). Both public views are slices of THIS list, so
// words[i] ↔ indices[i] stay positionally aligned even when playOrder makes
// timeline order differ from source order (speech-block reorder).
function retimedWordEntries(
  words: TranscriptWord[],
  deleted: Set<number>,
  fps: number,
  offsetFrames: number,
  opts: EditOpts = {},
): RetimedWordEntry[] {
  const segs = keptSegments(words, deleted, fps, offsetFrames, opts);
  const out: RetimedWordEntry[] = [];
  for (let i = 0; i < words.length; i++) {
    if (deleted.has(i)) continue;
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    const seg = segs.find((s) => wS >= s.srcStartFrame && wS < s.srcEndFrame)
      ?? segs.find((s) => wS <= s.srcEndFrame && wE >= s.srcStartFrame);
    if (!seg) continue;
    const fromF = seg.fromFrame + (Math.max(wS, seg.srcStartFrame) - seg.srcStartFrame);
    const toF = seg.fromFrame + (Math.min(wE, seg.srcEndFrame) - seg.srcStartFrame);
    const start = (fromF / fps) * 1000;
    out.push({
      index: i,
      word: { text: words[i].text, start, end: Math.max(start + 1, (toF / fps) * 1000), speaker: words[i].speaker },
    });
  }
  out.sort((a, b) => a.word.start - b.word.start);
  for (let n = 1; n < out.length; n++) {
    const prev = out[n - 1]!.word;
    let word = out[n]!.word;
    if (word.start < prev.end) word = { ...word, start: prev.end };
    if (word.end <= word.start) word = { ...word, end: word.start + 1 };
    if (word !== out[n]!.word) out[n] = { index: out[n]!.index, word };
  }
  return out;
}

/** Source indices of words that SURVIVE the edit state (deletions + window),
 * in the SAME timeline order retimeWords emits its words — position i here is
 * the source index of retimeWords(...)[i], so caption overrides/refs that pair
 * the two arrays by position stay aligned under playOrder reordering. */
export function keptWordIndices(words: TranscriptWord[], deleted: Set<number>, fps: number, opts: EditOpts = {}): number[] {
  return retimedWordEntries(words, deleted, fps, 0, opts).map((entry) => entry.index);
}

// Re-project surviving words onto the EDITED timeline (`fVe` algorithm):
// clamp each word to its covering kept segment, map source-frame → timeline-frame,
// then de-overlap so timings stay monotonic. Returns words with TIMELINE ms.
// Words that fall in a deleted / compressed-out region are dropped.
export function retimeWords(
  words: TranscriptWord[],
  deleted: Set<number>,
  fps: number,
  offsetFrames: number,
  opts: EditOpts = {},
): TranscriptWord[] {
  return retimedWordEntries(words, deleted, fps, offsetFrames, opts).map((entry) => entry.word);
}

// ── split_item transcript partition with word/frame alignment ──────────────
// A clip's `transcript` is exactly the words for its own source window — resolve.ts
// renders retimeWords(item.transcript, …, item.startFrame) with NO srcIn windowing, so a
// split half that kept the whole word list would render the OTHER half's words. split must
// therefore partition the words (and deletedWordIdx / variants / gapCaps, all keyed by
// source word index) at the cut. transcriptPlayOrder is intentionally dropped on split — a
// reordered clip has no well-defined source-position cut; it resets to chronological.

/** A clip's transcript-edit state that split_item must partition per half. */
export interface ClipTranscriptState {
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
  variants?: TranscriptVariant[];
  gapCapsMs?: Record<string, number>;
  silenceFrames?: number;
}

/** Source-word boundary index k for an edited-timeline cut (frames into the clip): words
 *  [0,k) → left half, [k,n) → right. Uses chronological kept segments so the cut maps to
 *  the correct source frame even when words were deleted or pauses compressed. */
function sourceSplitIndex(words: TranscriptWord[], deleted: Set<number>, fps: number, cutFrames: number, opts: EditOpts): number {
  const segs = keptSegments(words, deleted, fps, 0, opts);
  if (!segs.length) return 0;
  const seg = segs.find((s) => cutFrames >= s.fromFrame && cutFrames < s.fromFrame + s.durFrames);
  const boundarySrc = seg
    ? seg.srcStartFrame + (cutFrames - seg.fromFrame)
    : (cutFrames < segs[0]!.fromFrame ? segs[0]!.srcStartFrame : segs[segs.length - 1]!.srcEndFrame);
  for (let i = 0; i < words.length; i++) {
    if (msToFrame(words[i]!.start, fps) >= boundarySrc) return i;
  }
  return words.length;
}

/** Partition a clip's transcript-edit state at a cut into left/right halves so each half's
 *  words match its own source window. Returns null when there's no transcript to split. */
export function splitClipTranscript(
  clip: ClipTranscriptState,
  fps: number,
  cutFrames: number,
): { k: number; left: ClipTranscriptState; right: ClipTranscriptState } | null {
  const words = clip.transcript;
  if (!words?.length) return null;
  const deleted = new Set(clip.deletedWordIdx ?? []);
  const k = sourceSplitIndex(words, deleted, fps, cutFrames, { maxGapFrames: clip.silenceFrames, gapCapsMs: clip.gapCapsMs });

  const del = clip.deletedWordIdx ?? [];
  const leftCaps: Record<string, number> = {};
  const rightCaps: Record<string, number> = {};
  for (const [key, ms] of Object.entries(clip.gapCapsMs ?? {})) {
    const j = Number(key);
    if (!Number.isFinite(j)) continue;
    if (j < k) leftCaps[key] = ms; // cap the gap before a left word
    else if (j > k) rightCaps[String(j - k)] = ms; // j===k is the boundary gap → dropped
  }
  const pickVariants = (keep: (i: number) => boolean, rebase: (i: number) => number) =>
    (clip.variants ?? [])
      .map((v) => ({ ...v, words: v.words.filter((w) => keep(w.i)).map((w) => ({ ...w, i: rebase(w.i) })) }))
      .filter((v) => v.words.length > 0);
  const undefIfEmptyRec = (o: Record<string, number>) => (Object.keys(o).length ? o : undefined);
  const undefIfEmptyArr = <T,>(a: T[]) => (a.length ? a : undefined);

  return {
    k,
    left: {
      transcript: words.slice(0, k),
      deletedWordIdx: del.filter((i) => i < k),
      variants: undefIfEmptyArr(pickVariants((i) => i < k, (i) => i)),
      gapCapsMs: undefIfEmptyRec(leftCaps),
      silenceFrames: clip.silenceFrames,
    },
    right: {
      transcript: words.slice(k),
      deletedWordIdx: del.filter((i) => i >= k).map((i) => i - k),
      variants: undefIfEmptyArr(pickVariants((i) => i >= k, (i) => i - k)),
      gapCapsMs: undefIfEmptyRec(rightCaps),
      silenceFrames: clip.silenceFrames,
    },
  };
}

// Fixed filler tokens clean_script strips ("mechanical clean" — no LLM).
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mmm', '嗯', '呃', '啊', '唔', '额']);

export function isFiller(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z一-鿿]/g, '');
  return t.length > 0 && FILLER.has(t);
}

/** Indices of filler words in a transcript (for clean_script filler removal). */
export function fillerIndices(words: TranscriptWord[]): number[] {
  const idxs: number[] = [];
  for (let i = 0; i < words.length; i++) if (isFiller(words[i].text)) idxs.push(i);
  return idxs;
}

// ── Caption projection of video files: media frame window direct projection (2026-07-17, long to short e2e capture)─────────
// The srcInFrame semantics of audio and video are different: the window of audio is cut on the "edited word flow"
// (Playback layer rendering keptSegments, word deletion=cut audio); video then **continuously plays** the media
// [srcIn, srcIn+dur×rate)(TimelineComposition's OffthreadVideo trimBefore,
// Word-level deletion does not change the video screen). Captions must be faithful to actual playback: video files are placed in media frame windows
// Words are directly thrown into the timeline, and the timing will never be rearranged; and **words will not be hidden even if they are deleted** - all the voices in the window can be heard,
// Hiding its captions is an accident of "someone speaks without captions in the first few seconds" (agent's delete_text selection
// often narrower than the srcIn window it cuts). To hide individual words in captions, use wordOverrides(
// edit_captions display_text {hidden}), that is the display decision of the caption layer.
interface MediaWindowItem {
  startFrame: number;
  durationInFrames: number;
  srcInFrame?: number;
  playbackRate?: number;
}

/** video file: all words in the window (timeline ms) - displayed when heard, transcript deletion will not be involved. */
export function mediaWindowWords(
  words: TranscriptWord[],
  fps: number,
  item: MediaWindowItem,
): TranscriptWord[] {
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const out: TranscriptWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    if (wE <= window.startFrame || wS >= window.endFrame) continue; // outside the window
    const fromF = item.startFrame + sourceFramesToTimelineFrames(item, Math.max(wS, window.startFrame) - window.startFrame);
    const toF = item.startFrame + sourceFramesToTimelineFrames(item, Math.min(wE, window.endFrame) - window.startFrame);
    const start = (fromF / fps) * 1000;
    out.push({ text: words[i].text, start, end: Math.max(start + 1, (toF / fps) * 1000), speaker: words[i].speaker });
  }
  return out;
}

/** Source word index (wordOverrides key) with the same set of survival rules as mediaWindowWords. */
export function mediaWindowKeptIndices(
  words: TranscriptWord[],
  fps: number,
  item: MediaWindowItem,
): number[] {
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const idxs: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    if (wE <= window.startFrame || wS >= window.endFrame) continue;
    idxs.push(i);
  }
  return idxs;
}

/** Clip fields needed to project a source word onto the timeline. */
interface WordSeekItem extends MediaWindowItem {
  kind: string;
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
  silenceFrames?: number;
  gapCapsMs?: Record<string, number>;
  transcriptPlayOrder?: number[];
  cutPadFrames?: number;
}

/**
 * Timeline frame where a SOURCE word starts playing inside this clip — the
 * same projection the render/caption layers use (audio = edited kept-segment
 * stream honoring deletions/silence/playOrder/trim window; video = continuous
 * [srcIn, srcIn+dur×rate) media window). Naive `startFrame + msToFrame(word.start)`
 * is WRONG whenever the clip was split/trimmed/edited/rate-stretched.
 * A word whose span touches a kept segment (e.g. a deleted word at a cut)
 * maps to the cut point where playback resumes; returns null only when the
 * word cannot be located in this clip's playback at all (outside the trim
 * window / inside a fully removed span).
 */
export function wordTimelineFrame(item: WordSeekItem, word: TranscriptWord, fps: number): number | null {
  const wS = msToFrame(word.start, fps);
  const wE = msToFrame(word.end, fps);
  if (item.kind !== 'audio') {
    const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
    if (wE <= window.startFrame || wS >= window.endFrame) return null;
    const local = Math.round(sourceFramesToTimelineFrames(item, Math.max(wS, window.startFrame) - window.startFrame));
    return item.startFrame + Math.min(Math.max(0, local), Math.max(0, item.durationInFrames - 1));
  }
  const deleted = new Set(item.deletedWordIdx ?? []);
  const segs = keptSegments(item.transcript ?? [], deleted, fps, 0, { ...itemEditOpts(item), window: itemWindow(item) });
  const seg = segs.find((s) => wS >= s.srcStartFrame && wS < s.srcEndFrame)
    ?? segs.find((s) => wS <= s.srcEndFrame && wE >= s.srcStartFrame);
  if (!seg) return null;
  return item.startFrame + seg.fromFrame + (Math.max(wS, seg.srcStartFrame) - seg.srcStartFrame);
}
