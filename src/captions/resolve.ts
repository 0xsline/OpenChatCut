import type { CaptionsData, CaptionSourceEntry, CaptionWordOverride } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { itemWindow, keptWordIndices, mediaWindowKeptIndices, mediaWindowWords, retimeWords } from '../transcript/edit';
import { findVariantByLang, resolveVariantText } from '../transcript/variants';
import { orderedCaptionSourceEntries } from './sourceOrder';

// Word → Timeline projections are split by kind and aligned with the playback layer:
// audio = word flow after editing (keptSegments rearrangement, word deletion/mute/trim window all take effect);
// video = continuous playback of media [srcIn, srcIn+dur×rate), which can be heard and displayed in the window——transcript
// Deleted words are not hidden, and timing is never rearranged (TimelineComposition is constant for video OffthreadVideo
// trimBefore, the word editor does not change the picture; the subtitle layer needs to hide the words (wordOverrides).
function projectItemWords(item: TimelineItem, src: TranscriptWord[], del: Set<number>, fps: number): TranscriptWord[] {
  if (item.kind !== 'audio') return mediaWindowWords(src, fps, item);
  return retimeWords(src, del, fps, item.startFrame, {
    maxGapFrames: item.silenceFrames, gapCapsMs: item.gapCapsMs, playOrder: item.transcriptPlayOrder,
    window: itemWindow(item),
  });
}

function projectItemIndices(item: TimelineItem, del: Set<number>, fps: number): number[] {
  if (item.kind !== 'audio') return mediaWindowKeptIndices(item.transcript ?? [], fps, item);
  return keptWordIndices(item.transcript ?? [], del, fps, {
    maxGapFrames: item.silenceFrames, gapCapsMs: item.gapCapsMs, playOrder: item.transcriptPlayOrder,
    window: itemWindow(item),
  });
}

// Items participating in a MULTI-source merge (`sourceMode:'timeline'` = every
// transcribed item; `sources` = the listed item ids), or undefined when captions
// use the single-source `sourceItemId`/standalone path — kept as a SEPARATE
// branch in resolveCaptionWords/resolveCaptionWordIndices below so that
// pre-existing single-source behavior stays byte-identical (no merge = same
// code path as before this feature).
function mergedSourceItems(captions: CaptionsData, items: TimelineItem[]): TimelineItem[] | undefined {
  if (captions.sourceMode === 'timeline') {
    const all = items.filter((it) => (it.transcript?.length ?? 0) > 0);
    return all.length ? [...all].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)) : undefined;
  }
  if (captions.sources?.length) {
    const found = captions.sources
      .map((id) => items.find((it) => it.id === id))
      .filter((it): it is TimelineItem => !!it?.transcript?.length);
    return found.length ? found : undefined;
  }
  return undefined;
}

/** One lane's words (TIMELINE ms): the entry's item transcript, variant text
 * swapped in BEFORE retiming (Translation only changes the text, and the timing always comes from the source word),
 * deletions/silence/trim window all honored (same math as the play layer). */
export function resolveEntryWords(entry: CaptionSourceEntry, items: TimelineItem[], fps: number): TranscriptWord[] {
  if (entry.words) return entry.words.map((word) => ({ ...word }));
  const item = items.find((it) => it.id === entry.itemId);
  if (!item?.transcript?.length) return [];
  const del = new Set(item.deletedWordIdx ?? []);
  const variant = entry.variant
    ? findVariantByLang(item.variants ?? [], entry.variant.languageCode, entry.variant.variantKind)
    : undefined;
  const src = variant ? resolveVariantText(item.transcript, variant) : item.transcript;
  return projectItemWords(item, src, del, fps);
}

// Re-project + merge every participating item's transcript onto the timeline,
// then sort by absolute start (the merge itself — no cross-item de-overlap, so
// each word keeps its own text/start/end exactly as retimeWords produced it
// for its own item, preserving word/frame alignment per source).
function mergeWords(sourceItems: TimelineItem[], fps: number): TranscriptWord[] {
  const all: TranscriptWord[] = [];
  for (const it of sourceItems) {
    const del = new Set(it.deletedWordIdx ?? []);
    all.push(...projectItemWords(it, it.transcript ?? [], del, fps)); // Subtitles follow actual playback (streaming by kind)
  }
  return all.sort((a, b) => a.start - b.start);
}

// Resolve caption words as TIMELINE-ms words. Multi-source merge (sources[] /
// sourceMode:'timeline') takes priority when set; else prefer the referenced
// audio item's transcript re-projected onto the edited timeline (captions
// follow deletions + silence compression); else shift the standalone words by
// the offset. Shared by the render layer, the translation generator, and the
// agent tool so all three agree on what text/timing the captions currently show.
export function resolveCaptionWords(captions: CaptionsData, items: TimelineItem[], fps: number): TranscriptWord[] {
  if (captions.sourceEntries?.length) {
    return orderedCaptionSourceEntries(captions.sourceEntries)
      .filter((entry) => entry.visible !== false)
      .flatMap((entry) => resolveEntryWords(entry, items, fps))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }
  const merged = mergedSourceItems(captions, items);
  if (merged) return mergeWords(merged, fps);
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (item?.transcript?.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    // Swap in the chosen variant's TEXT on the SOURCE words BEFORE retiming, so all
    // timing comes from the projection (source frames) — the variant never touches a
    // start/end. No variant selected → source words remain unchanged.
    const variant = captions.captionVariantId ? item.variants?.find((v) => v.id === captions.captionVariantId) : undefined;
    const src = variant ? resolveVariantText(item.transcript, variant) : item.transcript;
    return projectItemWords(item, src, del, fps);
  }
  const offMs = ((captions.offsetFrames ?? 0) / fps) * 1000;
  return (captions.words ?? []).map((w) => ({ ...w, start: w.start + offMs, end: w.end + offMs }));
}

// The index each word `resolveCaptionWords` returns should be keyed by for
// `wordOverrides`. Single-source (unchanged): the ORIGINAL track-transcript
// index (same order + length — deleted words are dropped from both the same
// way, kept words stay in source order). Multi-source merge: there is no
// single source transcript to index into, so overrides key off the word's
// POSITION in the merged output instead (0..N-1) — simplest mapping that
// stays well-defined regardless of how many items were merged (see
// CaptionsData.wordOverrides doc in types.ts).
export function resolveCaptionWordIndices(captions: CaptionsData, items: TimelineItem[], fps: number): number[] {
  if (captions.sourceEntries?.length) {
    const count = captions.sourceEntries
      .filter((entry) => entry.visible !== false)
      .reduce((total, entry) => total + resolveEntryWords(entry, items, fps).length, 0);
    return Array.from({ length: count }, (_, i) => i);
  }
  const merged = mergedSourceItems(captions, items);
  if (merged) {
    const count = merged.reduce((n, it) => {
      const del = new Set(it.deletedWordIdx ?? []);
      return n + projectItemIndices(it, del, fps).length;
    }, 0);
    return Array.from({ length: count }, (_, i) => i);
  }
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (item?.transcript?.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    // The same set of survival rules as resolveCaptionWords (divided according to kind), otherwise wordOverrides will be misplaced
    return projectItemIndices(item, del, fps);
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
