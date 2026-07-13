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
}

export function keptSegments(
  words: TranscriptWord[],
  deleted: Set<number>,
  fps: number,
  offsetFrames: number,
  opts: EditOpts = {},
): KeptSegment[] {
  const { maxGapFrames } = opts;
  const segs: KeptSegment[] = [];
  let pos = offsetFrames;
  let i = 0;
  while (i < words.length) {
    if (deleted.has(i)) { i++; continue; }
    const srcStart = msToFrame(words[i].start, fps);
    let srcEnd = msToFrame(words[i].end, fps);
    // extend through consecutive kept words, cutting where a pause is too long
    while (i + 1 < words.length && !deleted.has(i + 1)) {
      const nextStart = msToFrame(words[i + 1].start, fps);
      const gap = nextStart - srcEnd;
      if (maxGapFrames != null && gap > maxGapFrames) {
        srcEnd += maxGapFrames; // keep only the target amount of trailing silence
        break; // the next kept word begins a fresh segment
      }
      i += 1;
      srcEnd = msToFrame(words[i].end, fps);
    }
    const durFrames = Math.max(1, srcEnd - srcStart);
    segs.push({ srcStartFrame: srcStart, srcEndFrame: srcEnd, fromFrame: pos, durFrames });
    pos += durFrames;
    i += 1;
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
