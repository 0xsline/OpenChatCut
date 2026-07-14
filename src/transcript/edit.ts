import { msToFrame, type TranscriptWord } from './types';

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
   * 0 ms = delete the gap (source Gap trash).
   */
  gapCapsMs?: Record<string, number>;
  /** Source word indices in playback order (speech-block drag). */
  playOrder?: number[];
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
    // Merge forward while source time advances (contiguous play); stop on reorder jumps.
    while (sj + 1 < seq.length) {
      const nextWi = seq[sj + 1]!;
      const nextStart = msToFrame(words[nextWi]!.start, fps);
      if (nextStart < srcStart) break; // playback jumps earlier in source → new segment
      const gap = nextStart - srcEnd;
      if (gap < 0) break; // overlap / reverse → new segment
      const cap = gapCapFrames(opts, nextWi, fps);
      if (cap != null && gap > cap) {
        srcEnd += cap;
        break;
      }
      srcEnd = msToFrame(words[nextWi]!.end, fps);
      sj += 1;
    }
    const durFrames = Math.max(1, srcEnd - srcStart);
    segs.push({ srcStartFrame: srcStart, srcEndFrame: srcEnd, fromFrame: pos, durFrames });
    pos += durFrames;
    si = sj + 1;
  }
  return segs;
}

// Edited clip length in frames (sum of kept segment durations), min 1.
export function editedFrames(words: TranscriptWord[], deleted: Set<number>, fps: number, opts: EditOpts = {}): number {
  const total = keptSegments(words, deleted, fps, 0, opts).reduce((s, seg) => s + seg.durFrames, 0);
  return Math.max(1, total);
}

// Re-project surviving words onto the EDITED timeline (source-faithful `fVe`):
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

// Fixed filler tokens ChatCut's clean_script strips ("mechanical clean" — no LLM).
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
