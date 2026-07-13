import { msToFrame, type TranscriptWord } from './types';

// Transcript-based editing: deleting a word removes its audible source range.
// The kept audio = maximal runs of NON-deleted words, each run playing the
// source span [firstWord.start, lastWord.end], concatenated back-to-back (so a
// middle deletion ripples the tail earlier). This is the "delete text = delete
// video" model.

export interface KeptSegment {
  srcStartFrame: number; // trim point in the source
  srcEndFrame: number;
  fromFrame: number; // position on the timeline
  durFrames: number;
}

export function keptSegments(words: TranscriptWord[], deleted: Set<number>, fps: number, offsetFrames: number): KeptSegment[] {
  const segs: KeptSegment[] = [];
  let pos = offsetFrames;
  let i = 0;
  while (i < words.length) {
    if (deleted.has(i)) { i++; continue; }
    const runStart = i;
    while (i < words.length && !deleted.has(i)) i++;
    const srcStartFrame = msToFrame(words[runStart].start, fps);
    const srcEndFrame = msToFrame(words[i - 1].end, fps);
    const durFrames = Math.max(1, srcEndFrame - srcStartFrame);
    segs.push({ srcStartFrame, srcEndFrame, fromFrame: pos, durFrames });
    pos += durFrames;
  }
  return segs;
}

// Edited clip length in frames (sum of kept segment durations), min 1.
export function editedFrames(words: TranscriptWord[], deleted: Set<number>, fps: number): number {
  const total = keptSegments(words, deleted, fps, 0).reduce((s, seg) => s + seg.durFrames, 0);
  return Math.max(1, total);
}
