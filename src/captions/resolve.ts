import type { CaptionsData, CaptionWordOverride } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { retimeWords } from '../transcript/edit';

// Resolve caption words as TIMELINE-ms words. Prefer the referenced audio item's
// transcript re-projected onto the edited timeline (captions follow deletions +
// silence compression); else shift the standalone words by the offset. Shared by
// the render layer, the translation generator, and the agent tool so all three
// agree on what text/timing the captions currently show.
export function resolveCaptionWords(captions: CaptionsData, items: TimelineItem[], fps: number): TranscriptWord[] {
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (item?.transcript?.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return retimeWords(item.transcript, del, fps, item.startFrame, { maxGapFrames: item.silenceFrames });
  }
  const offMs = ((captions.offsetFrames ?? 0) / fps) * 1000;
  return (captions.words ?? []).map((w) => ({ ...w, start: w.start + offMs, end: w.end + offMs }));
}

// The ORIGINAL track-transcript index for each word `resolveCaptionWords`
// returns (same order + length — deleted words are dropped from both the same
// way, kept words stay in source order). `wordOverrides` is keyed by this
// index, not by a word's position in the (possibly edited) resolved list.
export function resolveCaptionWordIndices(captions: CaptionsData, items: TimelineItem[]): number[] {
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (item?.transcript?.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return item.transcript.map((_, i) => i).filter((i) => !del.has(i));
  }
  return (captions.words ?? []).map((_, i) => i);
}

// Apply per-word display overrides ahead of pagination: a hidden word is
// dropped, a text override replaces the shown word (timing untouched), a
// forceBreak word marks where a new page should start. Returns the words to
// paginate + the positions (in the RETURNED array) to break before. No
// overrides (or an empty map) is a no-op — same words reference, empty
// breakBefore — so paginate's output stays byte-identical to today.
export function applyWordOverrides(
  words: TranscriptWord[],
  indices: number[],
  overrides: Record<number, CaptionWordOverride> | undefined,
): { words: TranscriptWord[]; breakBefore: Set<number> } {
  if (!overrides || Object.keys(overrides).length === 0) return { words, breakBefore: new Set() };
  const out: TranscriptWord[] = [];
  const breakBefore = new Set<number>();
  for (let j = 0; j < words.length; j++) {
    const ov = overrides[indices[j]];
    if (ov?.hidden) continue;
    if (ov?.forceBreak && out.length > 0) breakBefore.add(out.length);
    out.push(ov?.text ? { ...words[j], text: ov.text } : words[j]);
  }
  return { words: out, breakBefore };
}
