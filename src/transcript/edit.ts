import { msToFrame, type TranscriptWord, type TranscriptVariant } from './types';

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
   * Visible window over the EDITED (kept) stream, in edited-local frames —
   * the trim handles' [srcInFrame, srcInFrame+durationInFrames) slice. Segments
   * outside are dropped, boundary segments clipped, survivors re-packed from
   * offsetFrames. Undefined = whole stream (pre-window behavior, byte-identical).
   * 修「trim 转写 clip 改帧不改词」软点:渲染/字幕/find 全走这一个闸门。
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

  const segs: KeptSegment[] = [];
  let pos = offsetFrames;
  let si = 0;
  while (si < seq.length) {
    const wi = seq[si]!;
    const srcStart = msToFrame(words[wi]!.start, fps);
    let srcEnd = msToFrame(words[wi]!.end, fps);
    let sj = si;
    let curWi = wi; // last source word merged into this run
    // Merge forward ONLY through immediate chronological successors. A jump in
    // source index — deleted words sitting between (删词=删视频) or a play-order
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
        break;
      }
      srcEnd = msToFrame(words[nextWi]!.end, fps);
      curWi = nextWi;
      sj += 1;
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

// Edited clip length in frames (sum of kept segment durations), min 1.
export function editedFrames(words: TranscriptWord[], deleted: Set<number>, fps: number, opts: EditOpts = {}): number {
  const total = keptSegments(words, deleted, fps, 0, opts).reduce((s, seg) => s + seg.durFrames, 0);
  return Math.max(1, total);
}

/** Source indices of words that SURVIVE the edit state (deletions + window) — the
 * exact same segment-containment rule retimeWords uses, so callers that need
 * "which words does the render show" (caption word overrides) stay aligned. */
export function keptWordIndices(words: TranscriptWord[], deleted: Set<number>, fps: number, opts: EditOpts = {}): number[] {
  const segs = keptSegments(words, deleted, fps, 0, opts);
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (deleted.has(i)) continue;
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    const seg = segs.find((s) => wS >= s.srcStartFrame && wS < s.srcEndFrame)
      ?? segs.find((s) => wS <= s.srcEndFrame && wE >= s.srcStartFrame);
    if (seg) out.push(i);
  }
  return out;
}

// Re-project surviving words onto the EDITED timeline (`fVe` 算法):
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
  const segs = keptSegments(words, deleted, fps, offsetFrames, opts);
  const out: TranscriptWord[] = [];
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
    out.push({ text: words[i].text, start, end: Math.max(start + 1, (toF / fps) * 1000), speaker: words[i].speaker });
  }
  out.sort((a, b) => a.start - b.start);
  for (let n = 1; n < out.length; n++) {
    if (out[n].start < out[n - 1].end) out[n] = { ...out[n], start: out[n - 1].end };
    if (out[n].end <= out[n].start) out[n] = { ...out[n], end: out[n].start + 1 };
  }
  return out;
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

// ── video 件的字幕投影:媒体帧窗口直投(2026-07-17,长转短 e2e 抓获)─────────
// audio 与 video 的 srcInFrame 语义不同:audio 的窗口切在"编辑后词流"上
// (播放层渲 keptSegments,删词=剪音频);video 则**永远连续播放**媒体
// [srcIn, srcIn+dur×rate)(TimelineComposition 的 OffthreadVideo trimBefore,
// 词级删除不改视频画面)。字幕必须忠实于实际播放:video 件按媒体帧窗口把
// 词直投到时间线,时序绝不重排;且**删词也不隐藏**——窗口内的语音都可闻,
// 藏掉它的字幕就是"开头几秒有人说话没字幕"事故(agent 的 delete_text 选区
// 常比它切的 srcIn 窗口窄)。要在字幕里隐藏个别词走 wordOverrides(
// edit_captions display_text {hidden}),那才是字幕层的显示决定。
interface MediaWindowItem {
  startFrame: number;
  durationInFrames: number;
  srcInFrame?: number;
  playbackRate?: number;
}

/** video 件:窗口内全部词(时间线 ms)——可闻即显,transcript 删词不参与。 */
export function mediaWindowWords(
  words: TranscriptWord[],
  fps: number,
  item: MediaWindowItem,
): TranscriptWord[] {
  const rate = item.playbackRate ?? 1;
  const srcIn = item.srcInFrame ?? 0;
  const winEnd = srcIn + item.durationInFrames * rate;
  const out: TranscriptWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    if (wE <= srcIn || wS >= winEnd) continue; // 窗口外
    const fromF = item.startFrame + (Math.max(wS, srcIn) - srcIn) / rate;
    const toF = item.startFrame + (Math.min(wE, winEnd) - srcIn) / rate;
    const start = (fromF / fps) * 1000;
    out.push({ text: words[i].text, start, end: Math.max(start + 1, (toF / fps) * 1000), speaker: words[i].speaker });
  }
  return out;
}

/** 与 mediaWindowWords 同一套存活规则的源词索引(wordOverrides 键)。 */
export function mediaWindowKeptIndices(
  words: TranscriptWord[],
  fps: number,
  item: MediaWindowItem,
): number[] {
  const rate = item.playbackRate ?? 1;
  const srcIn = item.srcInFrame ?? 0;
  const winEnd = srcIn + item.durationInFrames * rate;
  const idxs: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    if (wE <= srcIn || wS >= winEnd) continue;
    idxs.push(i);
  }
  return idxs;
}
