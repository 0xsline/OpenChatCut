import type { CaptionsData, CaptionSourceEntry, CaptionWordOverride } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { itemEditOpts, itemWindow, keptWordIndices, mediaWindowKeptIndices, mediaWindowWords, retimeWords } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import { isStableIdentity } from '../transcript/identity';
import { findVariantByLang, resolveVariantText } from '../transcript/variants';
import { orderedCaptionSourceEntries } from './sourceOrder';

// Word → Timeline projection is split by kind and consistent with the playback layer:
// audio = word flow after editing (keptSegments rearrangement, word deletion/mute/trim window all take effect);
// video = continuous playback of media [srcIn, srcIn+dur×rate), which can be heard and displayed in the window — transcript
// Deleted words are not hidden, and timing is never rearranged (TimelineComposition is constant for video OffthreadVideo
// trimBefore, word editing does not change the picture; the caption layer needs to hide words (wordOverrides).
function projectItemWords(item: TimelineItem, src: TranscriptWord[], del: Set<number>, fps: number): TranscriptWord[] {
  if (item.kind !== 'audio') return mediaWindowWords(src, fps, item);
  return retimeWords(src, del, fps, item.startFrame, { ...itemEditOpts(item), window: itemWindow(item) });
}

function projectItemIndices(item: TimelineItem, del: Set<number>, fps: number): number[] {
  if (item.kind !== 'audio') return mediaWindowKeptIndices(item.transcript ?? [], fps, item);
  return keptWordIndices(item.transcript ?? [], del, fps, { ...itemEditOpts(item), window: itemWindow(item) });
}

const encodeWordRef = (scope: readonly string[], generationId: string, wordId: string): string =>
  `cw2.${encodeURIComponent(JSON.stringify([...scope, generationId, wordId]))}`;

function itemWordRefs(item: TimelineItem, laneId: string | undefined, fps: number): string[] {
  const indices = projectItemIndices(item, new Set(item.deletedWordIdx ?? []), fps);
  const scope = laneId ? ['lane', laneId] : ['item', item.id];
  return indices.map((index) => {
    const wordId = item.transcript?.[index]?.id;
    return isStableIdentity(item.transcriptGenerationId) && isStableIdentity(wordId)
      ? encodeWordRef(scope, item.transcriptGenerationId, wordId)
      : '';
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
    const all = items.filter((it) => hasOperationalTranscript(it));
    return all.length ? [...all].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)) : undefined;
  }
  if (captions.sources?.length) {
    const found = captions.sources
      .map((id) => items.find((it) => it.id === id))
      .filter((it): it is TimelineItem => hasOperationalTranscript(it));
    return found.length ? found : undefined;
  }
  return undefined;
}

/** One lane's words (TIMELINE ms): the entry's item transcript, variant text
 * swapped in BEFORE retiming (the translation only changes the text, the timing always comes from the source word),
 * deletions/silence/trim window all honored (same math as the play layer). */
export function resolveEntryWords(entry: CaptionSourceEntry, items: TimelineItem[], fps: number): TranscriptWord[] {
  if (entry.words) return entry.words.map((word) => ({ ...word }));
  const item = items.find((it) => it.id === entry.itemId);
  if (!hasOperationalTranscript(item)) return [];
  const del = new Set(item.deletedWordIdx ?? []);
  const variant = entry.variant
    ? findVariantByLang(item.variants ?? [], entry.variant.languageCode, entry.variant.variantKind)
    : undefined;
  const src = variant ? resolveVariantText(item.transcript, variant) : item.transcript;
  return projectItemWords(item, src, del, fps);
}

/** Stable refs aligned one-to-one with resolveEntryWords. */
export function resolveEntryWordRefs(entry: CaptionSourceEntry, items: TimelineItem[], fps: number): string[] {
  if (entry.words) return entry.words.map((word) =>
    isStableIdentity(entry.id) && isStableIdentity(word.id)
      ? encodeWordRef(['lane', entry.id], 'manual', word.id)
      : '');
  const item = items.find((candidate) => candidate.id === entry.itemId);
  return hasOperationalTranscript(item) ? itemWordRefs(item, entry.id, fps) : [];
}

// Re-project + merge every participating item's transcript onto the timeline,
// then sort by absolute start (the merge itself — no cross-item de-overlap, so
// each word keeps its own text/start/end exactly as retimeWords produced it
// for its own item, preserving word/frame alignment per source).
function mergeWords(sourceItems: TimelineItem[], fps: number): TranscriptWord[] {
  const all: TranscriptWord[] = [];
  for (const it of sourceItems) {
    const del = new Set(it.deletedWordIdx ?? []);
    all.push(...projectItemWords(it, it.transcript ?? [], del, fps)); // Captions follow actual playback (split by kind)
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
  if (captions.sourceMode === 'timeline' || captions.sources?.length) return [];
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (hasOperationalTranscript(item)) {
    const del = new Set(item.deletedWordIdx ?? []);
    // Swap in the chosen variant's TEXT on the SOURCE words BEFORE retiming, so all
    // timing comes from the projection (source frames) — the variant never touches a
    // start/end. No variant selected → source words remain unchanged.
    const variant = captions.captionVariantId ? item.variants?.find((v) => v.id === captions.captionVariantId) : undefined;
    const src = variant ? resolveVariantText(item.transcript, variant) : item.transcript;
    return projectItemWords(item, src, del, fps);
  }
  if (captions.sourceItemId) return [];
  const offMs = ((captions.offsetFrames ?? 0) / fps) * 1000;
  return (captions.words ?? []).map((w) => ({ ...w, start: w.start + offMs, end: w.end + offMs }));
}

interface TimedWordRef {
  word: TranscriptWord;
  ref: string;
}

function mergedWordRefs(sourceItems: TimelineItem[], fps: number): string[] {
  const pairs: TimedWordRef[] = [];
  for (const item of sourceItems) {
    const words = projectItemWords(item, item.transcript ?? [], new Set(item.deletedWordIdx ?? []), fps);
    const refs = itemWordRefs(item, undefined, fps);
    words.forEach((word, index) => pairs.push({ word, ref: refs[index]! }));
  }
  return pairs.sort((a, b) => a.word.start - b.word.start).map(({ ref }) => ref);
}

/** Opaque stable word identities aligned one-to-one with resolveCaptionWords. */
export function resolveCaptionWordRefs(captions: CaptionsData, items: TimelineItem[], fps: number): string[] {
  if (captions.sourceEntries?.length) {
    const pairs = orderedCaptionSourceEntries(captions.sourceEntries)
      .filter((entry) => entry.visible !== false)
      .flatMap((entry) => {
        const words = resolveEntryWords(entry, items, fps);
        const refs = resolveEntryWordRefs(entry, items, fps);
        return words.map((word, index) => ({ word, ref: refs[index]! }));
      });
    return pairs
      .sort((a, b) => a.word.start - b.word.start || a.word.end - b.word.end)
      .map(({ ref }) => ref);
  }
  const merged = mergedSourceItems(captions, items);
  if (merged) return mergedWordRefs(merged, fps);
  if (captions.sourceMode === 'timeline' || captions.sources?.length) return [];
  const item = captions.sourceItemId ? items.find((candidate) => candidate.id === captions.sourceItemId) : undefined;
  if (hasOperationalTranscript(item)) return itemWordRefs(item, undefined, fps);
  if (captions.sourceItemId) return [];
  return (captions.words ?? []).map((word) =>
    isStableIdentity(word.id) ? encodeWordRef(['lane', 'standalone'], 'standalone', word.id) : '');
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
  if (captions.sourceMode === 'timeline' || captions.sources?.length) return [];
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (hasOperationalTranscript(item)) {
    const del = new Set(item.deletedWordIdx ?? []);
    // The same set of survival rules as resolveCaptionWords (divided according to kind), otherwise wordOverrides will be misplaced
    return projectItemIndices(item, del, fps);
  }
  if (captions.sourceItemId) return [];
  return (captions.words ?? []).map((_, i) => i);
}

export interface AppliedCaptionWords {
  words: TranscriptWord[];
  indices: number[];
  wordRefs: string[];
  overrides: Array<CaptionWordOverride | undefined>;
  breakBefore: Set<number>;
}

// Apply display overrides before pagination. Stable refs take precedence; a
// numeric fallback is used only for legacy values that have no wordRef metadata.
export function applyWordOverrides(
  words: TranscriptWord[],
  indices: number[],
  overrides: Record<number, CaptionWordOverride> | undefined,
  wordRefs: string[] = [],
): AppliedCaptionWords {
  const refCounts = new Map<string, number>();
  for (const ref of wordRefs) if (ref) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
  const stable = new Map<string, CaptionWordOverride>();
  for (const override of Object.values(overrides ?? {})) {
    if (override.wordRef && !stable.has(override.wordRef)) stable.set(override.wordRef, override);
  }
  const out: TranscriptWord[] = [];
  const outIndices: number[] = [];
  const outRefs: string[] = [];
  const applied: Array<CaptionWordOverride | undefined> = [];
  const breakBefore = new Set<number>();
  for (let position = 0; position < words.length; position++) {
    const legacy = overrides?.[indices[position]!];
    const ref = wordRefs[position];
    const override = (ref && refCounts.get(ref) === 1 ? stable.get(ref) : undefined)
      ?? (legacy?.wordRef ? undefined : legacy);
    if (override?.hidden) continue;
    if (override?.forceBreak && out.length > 0) breakBefore.add(out.length);
    const timingOffsetMs = override?.timingOffsetMs ?? 0;
    const word = words[position]!;
    out.push(override?.text || timingOffsetMs
      ? { ...word, ...(override?.text ? { text: override.text } : {}), start: word.start + timingOffsetMs, end: word.end + timingOffsetMs }
      : word);
    outIndices.push(indices[position]!);
    outRefs.push(ref ?? '');
    applied.push(override);
  }
  return { words: out, indices: outIndices, wordRefs: outRefs, overrides: applied, breakBefore };
}
