import { msToFrame, type TranscriptVariant, type TranscriptWord } from './types';
import { keptSegments, type KeptSegment } from './edit';
import { wordSegmentLookup } from './wordSegments';

// Splitting a clip whose speech blocks have been re-ordered (transcriptPlayOrder).
//
// A reordered audio clip renders `keptSegments(..., { playOrder })`, so its audio is a
// sequence of source spans that is NOT chronological. The generic split maps the cut back
// through chronological kept segments and then drops playOrder on both halves — the cut has
// no relation to the played order, and both halves replay the source chronologically
// (different audio from the un-split clip, not just re-partitioned; the frame totals still
// add up, so nothing looks wrong).
//
// This partition works IN THE PLAYED STREAM: the cut frame lands on the reordered segments,
// each half owns the words it plays (the word straddling the cut is shared and head/tail
// trimmed via srcInFrame), and each half re-encodes its slice of the play order.
//
// Representation note: keptSegments decides run merging by testing whether the NEXT played
// word's index is the current word's source index + 1, so a half's `transcript` array must
// stay a contiguous SOURCE slice — the played subset is expressed as source indices inside
// `transcriptPlayOrder`, and words of a slice that the other half plays sit dormant (not in
// the order). Deterministic, pure, reducer-level.

/** One half's transcript-edit state after the split. Shape matches
 *  `ClipTranscriptState` (edit.ts) plus the re-encoded play order and cut pads. */
export interface PlayOrderSplitPart {
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
  variants?: TranscriptVariant[];
  gapCapsMs?: Record<string, number>;
  silenceFrames?: number;
  transcriptPlayOrder?: number[];
  cutPadFrames?: number;
}

export interface PlayOrderSplitResult {
  left: PlayOrderSplitPart;
  right: PlayOrderSplitPart;
  /** edited-stream offset that makes the half render from the split's first source frame */
  leftSrcInFrame: number;
  rightSrcInFrame: number;
}

interface SplitClipInput {
  transcript?: TranscriptWord[];
  deletedWordIdx?: number[];
  variants?: TranscriptVariant[];
  gapCapsMs?: Record<string, number>;
  silenceFrames?: number;
  transcriptPlayOrder?: number[];
  cutPadFrames?: number;
  srcInFrame?: number;
  durationInFrames?: number;
}

/**
 * Partition a reordered word-driven audio clip at `cutFrames` (clip-local timeline frames).
 * Returns null when there is nothing to split. Both halves keep a contiguous source slice of
 * the parent's words and a play order re-encoded over that slice; `*SrcInFrame` trims each
 * half's edited stream so playback resumes exactly at the source frame of the cut.
 */
export function splitPlayOrderClip(
  clip: SplitClipInput,
  fps: number,
  cutFrames: number,
): PlayOrderSplitResult | null {
  const words = clip.transcript;
  if (!words?.length) return null;
  const n = words.length;
  const deleted = new Set(clip.deletedWordIdx ?? []);

  // The played word sequence exactly as keptSegments derives it (source indices).
  const seq = (clip.transcriptPlayOrder?.length
    ? clip.transcriptPlayOrder
    : words.map((_, i) => i)
  ).filter((i) => i >= 0 && i < n && !deleted.has(i));

  const fullOpts = {
    maxGapFrames: clip.silenceFrames,
    gapCapsMs: clip.gapCapsMs,
    playOrder: clip.transcriptPlayOrder,
    cutPadFrames: clip.cutPadFrames,
  };
  // The parent's played (reordered) stream, positions from frame 0.
  const segs = keptSegments(words, deleted, fps, 0, fullOpts);
  const lookup = wordSegmentLookup(segs);

  // The parent's visible window in full-stream coordinates: the split at `cutFrames`
  // (clip-local) cuts the stream at w0 + cutFrames.
  const w0 = clip.srcInFrame ?? 0;
  const p = w0 + cutFrames;

  // Source frame at a full-stream position (clamped to the first/last segment).
  const srcAt = (pos: number): number => {
    if (!segs.length) return 0;
    const seg = segs.find((s) => pos >= s.fromFrame && pos < s.fromFrame + s.durFrames);
    if (!seg) return pos < segs[0]!.fromFrame ? segs[0]!.srcStartFrame : segs[segs.length - 1]!.srcEndFrame;
    return seg.srcStartFrame + (pos - seg.fromFrame);
  };
  // Approximation of where a word that is NOT played (deleted, capped out, or outside a
  // subset playOrder) would sit: projected through the closest kept segment. These words
  // never render, so this only decides which half owns them for future edits.
  const approxPos = (srcStart: number): number => {
    if (!segs.length) return 0;
    let before: KeptSegment | undefined;
    let after: KeptSegment | undefined;
    for (const seg of segs) {
      if (seg.srcStartFrame <= srcStart) before = seg;
      else if (!after) after = seg;
    }
    if (before) return before.fromFrame + Math.max(0, srcStart - before.srcStartFrame);
    if (after) return after.fromFrame;
    return segs[segs.length - 1]!.fromFrame + Math.max(0, srcStart - segs[segs.length - 1]!.srcStartFrame);
  };

  // Played [from, to) frame range of every word in full-stream coordinates.
  const rangeOf = (i: number): { from: number; to: number } => {
    const ws = msToFrame(words[i]!.start, fps);
    const we = msToFrame(words[i]!.end, fps);
    const seg = lookup(ws, we);
    if (!seg) {
      const a = approxPos(ws);
      return { from: a, to: a };
    }
    const from = seg.fromFrame + Math.max(0, ws - seg.srcStartFrame);
    const to = seg.fromFrame + Math.max(0, Math.min(we, seg.srcEndFrame) - seg.srcStartFrame);
    return { from, to };
  };
  const positionOf = new Map<number, { from: number; to: number }>();
  for (let i = 0; i < n; i++) positionOf.set(i, rangeOf(i));

  // Words strictly before the cut go left, strictly after it go right; the word the cut
  // lands inside (straddler) is shared by both halves so neither loses audio.
  const straddlers = new Set<number>();
  const leftSet = new Set<number>();
  const rightSet = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = positionOf.get(i)!;
    if (r.to > p && r.from < p) straddlers.add(i);
    else if (r.from >= p) rightSet.add(i);
    else leftSet.add(i); // r.to <= p, or unplayed approximation before the cut
  }
  for (const i of straddlers) {
    leftSet.add(i);
    rightSet.add(i);
  }

  // Contiguous source slices that cover both halves. left = [0, kL), right = [kR, n);
  // kR <= kL always, so the slices overlap only across the shared/dormant band, and every
  // word index stays covered (keptSegments merges by array adjacency, so a half's array
  // must never have holes).
  const kL = leftSet.size ? Math.max(...leftSet) + 1 : 0;
  const kR = rightSet.size ? Math.min(...rightSet) : n;

  const buildPart = (start: number, end: number, members: Set<number>): PlayOrderSplitPart => {
    // keep the half's slice of the played sequence, local indices; identity order
    // collapses to undefined (= chronological) and stays byte-identical on replay
    const order = seq.filter((i) => members.has(i)).map((i) => i - start);
    const identity = order.length === end - start && order.every((x, at) => x === at);

    const caps: Record<string, number> = {};
    for (const [key, ms] of Object.entries(clip.gapCapsMs ?? {})) {
      const j = Number(key);
      // left keeps caps below its slice end; right keeps caps after its slice start,
      // rebased — the boundary gap (j === kR) is dropped exactly like the classic split.
      if (!Number.isFinite(j) || j < start + 1 || j >= end) continue;
      if (deleted.has(j) || deleted.has(j - 1)) continue;
      caps[String(j - start)] = ms;
    }
    const variants = (clip.variants ?? [])
      .map((variant) => ({
        ...variant,
        words: variant.words
          .filter((w) => w.i >= start && w.i < end && !deleted.has(w.i))
          .map((w) => ({ ...w, i: w.i - start })),
      }))
      .filter((variant) => variant.words.length > 0);

    return {
      transcript: words.slice(start, end),
      deletedWordIdx: [...deleted].filter((i) => i >= start && i < end).map((i) => i - start),
      variants: variants.length ? variants : undefined,
      gapCapsMs: Object.keys(caps).length ? caps : undefined,
      silenceFrames: clip.silenceFrames,
      transcriptPlayOrder: order.length && !identity ? order : undefined,
      cutPadFrames: clip.cutPadFrames,
    };
  };

  const left = buildPart(0, kL, leftSet);
  const right = buildPart(kR, n, rightSet);

  // Edited-stream offset that starts each half at the split's source frame.
  // The half's own kept stream begins at its first segment's source frame; the window
  // start (srcInFrame) trims any lead-in (the shared straddling word, or the parent's
  // own head trim) so playback resumes exactly where the un-split clip was cut.
  const firstSrcStart = (part: PlayOrderSplitPart): number | null => {
    const half = keptSegments(part.transcript ?? [], new Set(part.deletedWordIdx ?? []), fps, 0, {
      maxGapFrames: part.silenceFrames,
      gapCapsMs: part.gapCapsMs,
      playOrder: part.transcriptPlayOrder,
      cutPadFrames: part.cutPadFrames,
    });
    return half[0]?.srcStartFrame ?? null;
  };
  const trimTo = (desiredSrc: number, firstSrc: number | null): number =>
    firstSrc === null ? 0 : Math.max(0, desiredSrc - firstSrc);

  return {
    left,
    right,
    leftSrcInFrame: trimTo(srcAt(w0), firstSrcStart(left)),
    rightSrcInFrame: trimTo(srcAt(p), firstSrcStart(right)),
  };
}