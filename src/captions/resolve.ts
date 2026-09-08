import type { CaptionsData, CaptionSourceEntry, CaptionWordOverride } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { itemEditOpts, itemWindow, projectMediaWindowWords, projectRetimedWords } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import { isStableIdentity } from '../transcript/identity';
import { findVariantByLang, resolveVariantText } from '../transcript/variants';
import { orderedCaptionSourceEntries } from './sourceOrder';

export interface CaptionProjection {
  words: TranscriptWord[];
  indices: number[];
  wordRefs: string[];
  entries?: Map<CaptionSourceEntry, CaptionProjection>;
}

const emptyProjection = (): CaptionProjection => ({ words: [], indices: [], wordRefs: [] });
const encodeWordRef = (scope: readonly string[], generationId: string, wordId: string): string =>
  `cw2.${encodeURIComponent(JSON.stringify([...scope, generationId, wordId]))}`;

// Audio uses the edited stream; video uses its continuous media window.
// Resolve words and indices together so overrides and stable refs cannot drift.
function projectItem(item: TimelineItem, src: TranscriptWord[], fps: number, laneId?: string): CaptionProjection {
  const projection = item.kind === 'audio'
    ? projectRetimedWords(src, new Set(item.deletedWordIdx ?? []), fps, item.startFrame, { ...itemEditOpts(item), window: itemWindow(item) })
    : projectMediaWindowWords(src, fps, item);
  const scope = laneId ? ['lane', laneId] : ['item', item.id];
  const wordRefs = projection.indices.map((index) => {
    const wordId = item.transcript?.[index]?.id;
    return isStableIdentity(item.transcriptGenerationId) && isStableIdentity(wordId)
      ? encodeWordRef(scope, item.transcriptGenerationId, wordId)
      : '';
  });
  return { ...projection, wordRefs };
}

function mergedSourceItems(captions: CaptionsData, items: TimelineItem[]): TimelineItem[] | undefined {
  if (captions.sourceMode === 'timeline') {
    const all = items.filter((it) => hasOperationalTranscript(it));
    return all.length ? [...all].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)) : undefined;
  }
  if (captions.sources?.length) {
    const found = captions.sources.map((id) => items.find((it) => it.id === id))
      .filter((it): it is TimelineItem => hasOperationalTranscript(it));
    return found.length ? found : undefined;
  }
  return undefined;
}

export function resolveEntryProjection(entry: CaptionSourceEntry, items: TimelineItem[], fps: number): CaptionProjection {
  if (entry.words) return {
    words: entry.words.map((word) => ({ ...word })),
    indices: entry.words.map((_, index) => index),
    wordRefs: entry.words.map((word) => isStableIdentity(entry.id) && isStableIdentity(word.id)
      ? encodeWordRef(['lane', entry.id], 'manual', word.id) : ''),
  };
  const item = items.find((it) => it.id === entry.itemId);
  if (!hasOperationalTranscript(item)) return emptyProjection();
  const variant = entry.variant
    ? findVariantByLang(item.variants ?? [], entry.variant.languageCode, entry.variant.variantKind)
    : undefined;
  return projectItem(item, variant ? resolveVariantText(item.transcript, variant) : item.transcript, fps, entry.id);
}

function mergeProjections(projections: CaptionProjection[], sortEnd: boolean): CaptionProjection {
  const pairs = projections.flatMap(({ words, wordRefs }) => words.map((word, index) => ({ word, ref: wordRefs[index]! })));
  pairs.sort((a, b) => a.word.start - b.word.start || (sortEnd ? a.word.end - b.word.end : 0));
  return { words: pairs.map(({ word }) => word), indices: pairs.map((_, index) => index), wordRefs: pairs.map(({ ref }) => ref) };
}

/** One pure projection per caption snapshot, shared by pagination and identity lookup. */
export function resolveCaptionProjection(captions: CaptionsData, items: TimelineItem[], fps: number): CaptionProjection {
  if (captions.sourceEntries?.length) {
    const projected = orderedCaptionSourceEntries(captions.sourceEntries)
      .filter((entry) => entry.visible !== false)
      .map((entry) => [entry, resolveEntryProjection(entry, items, fps)] as const);
    return { ...mergeProjections(projected.map(([, projection]) => projection), true), entries: new Map(projected) };
  }
  const merged = mergedSourceItems(captions, items);
  if (merged) return mergeProjections(merged.map((item) => projectItem(item, item.transcript ?? [], fps)), false);
  if (captions.sourceMode === 'timeline' || captions.sources?.length) return emptyProjection();
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (hasOperationalTranscript(item)) {
    const variant = captions.captionVariantId ? item.variants?.find((v) => v.id === captions.captionVariantId) : undefined;
    return projectItem(item, variant ? resolveVariantText(item.transcript, variant) : item.transcript, fps);
  }
  if (captions.sourceItemId) return emptyProjection();
  const offMs = ((captions.offsetFrames ?? 0) / fps) * 1000;
  const words = captions.words ?? [];
  return {
    words: words.map((word) => ({ ...word, start: word.start + offMs, end: word.end + offMs })),
    indices: words.map((_, index) => index),
    wordRefs: words.map((word) => isStableIdentity(word.id) ? encodeWordRef(['lane', 'standalone'], 'standalone', word.id) : ''),
  };
}

export function resolveEntryWords(entry: CaptionSourceEntry, items: TimelineItem[], fps: number): TranscriptWord[] {
  return resolveEntryProjection(entry, items, fps).words;
}

export function resolveEntryWordRefs(entry: CaptionSourceEntry, items: TimelineItem[], fps: number): string[] {
  return resolveEntryProjection(entry, items, fps).wordRefs;
}

export function resolveCaptionWords(captions: CaptionsData, items: TimelineItem[], fps: number): TranscriptWord[] {
  return resolveCaptionProjection(captions, items, fps).words;
}

export function resolveCaptionWordRefs(captions: CaptionsData, items: TimelineItem[], fps: number): string[] {
  return resolveCaptionProjection(captions, items, fps).wordRefs;
}

export function resolveCaptionWordIndices(captions: CaptionsData, items: TimelineItem[], fps: number): number[] {
  return resolveCaptionProjection(captions, items, fps).indices;
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
