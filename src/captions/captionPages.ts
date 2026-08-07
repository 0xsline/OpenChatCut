import type { TimelineItem } from '../editor/types.js';
import { isStableIdentity } from '../transcript/identity.js';
import { isManualCaptionEntry } from './manualCaptions.js';
import { effectivePreset } from './renderStyles.js';
import {
  applyWordOverrides,
  resolveCaptionWordIndices,
  resolveCaptionWordRefs,
  resolveCaptionWords,
  resolveEntryWordRefs,
  resolveEntryWords,
} from './resolve.js';
import { orderedCaptionSourceEntries } from './sourceOrder.js';
import {
  CAPTION_MAX_CHARS_PER_LINE,
  CAPTION_MAX_VISUAL_LINES,
  activePage,
  paginate,
  type CaptionPage,
  type CaptionsData,
  type CaptionSourceEntry,
} from './types.js';

export interface CaptionPageIdentity {
  id: string;
  laneId: string;
  laneOrder: number;
  entry?: CaptionSourceEntry;
  page: CaptionPage;
  srcIdxs: number[];
  wordRefs: string[];
  manual: boolean;
}

const pageId = (laneId: string, refs: readonly string[], page: CaptionPage): string => {
  const stable = refs.length === page.words.length && refs.every(isStableIdentity);
  return stable
    ? `page2:${laneId}:${refs.join('|')}`
    : `legacy:${laneId}:${page.start}:${page.end}:${page.words.map((word) => word.text).join('\u0000')}`;
};

function lanePages(
  captions: CaptionsData,
  entry: CaptionSourceEntry,
  laneOrder: number,
  items: TimelineItem[],
  fps: number,
  globalIndexByRef: ReadonlyMap<string, number>,
): CaptionPageIdentity[] {
  const words = resolveEntryWords(entry, items, fps);
  const refs = resolveEntryWordRefs(entry, items, fps);
  // Stable source identity is authoritative. Numeric legacy positions are only
  const sourceIndices = refs.map((ref) => globalIndexByRef.get(ref) ?? -1);
  const indices = isStableIdentity(entry.id) ? sourceIndices.map(() => -1) : sourceIndices;
  const applied = applyWordOverrides(words, indices, captions.wordOverrides, refs);
  const requestedLines = captions.perSource?.[entry.id]?.maxLines;
  const validLines = typeof requestedLines === 'number' && Number.isFinite(requestedLines)
    ? Math.floor(requestedLines)
    : CAPTION_MAX_VISUAL_LINES;
  const lines = Math.max(1, Math.min(CAPTION_MAX_VISUAL_LINES, validLines));
  const preset = entry.style ? { ...effectivePreset(captions), ...entry.style } : effectivePreset(captions);
  const perPage = requestedLines === undefined ? preset.wordsPerPage : Math.max(1, (preset.wordsPerPage ?? 6) * lines);
  const manual = isManualCaptionEntry(entry);
  const pages = manual
    ? applied.words.map((word) => ({ words: [word], start: word.start, end: word.end }))
    : paginate(applied.words, captions.pacing, perPage, applied.breakBefore, CAPTION_MAX_CHARS_PER_LINE, lines);
  let cursor = 0;
  return pages.map((page) => {
    const wordRefs = applied.wordRefs.slice(cursor, cursor + page.words.length);
    const srcIdxs = wordRefs.map((ref) => globalIndexByRef.get(ref) ?? -1).filter((index) => index >= 0);
    cursor += page.words.length;
    return { id: pageId(entry.id, wordRefs, page), laneId: entry.id, laneOrder, entry, page, srcIdxs, wordRefs, manual };
  });
}

/** Canonical lane-aware pagination shared by preview, selection, and subtitle export. */
export function buildCaptionPages(captions: CaptionsData, items: TimelineItem[], fps: number): CaptionPageIdentity[] {
  if (captions.sourceEntries?.length) {
    const entries = orderedCaptionSourceEntries(captions.sourceEntries).filter((entry) => entry.visible !== false);
    const globalIndexByRef = new Map(resolveCaptionWordRefs(captions, items, fps).map((ref, index) => [ref, index]));
    return entries.flatMap((entry, laneOrder) => lanePages(captions, entry, laneOrder, items, fps, globalIndexByRef))
      .sort((left, right) => left.page.start - right.page.start || left.laneOrder - right.laneOrder || left.page.end - right.page.end || left.id.localeCompare(right.id));
  }
  const words = resolveCaptionWords(captions, items, fps);
  const refs = resolveCaptionWordRefs(captions, items, fps);
  const applied = applyWordOverrides(words, resolveCaptionWordIndices(captions, items, fps), captions.wordOverrides, refs);
  const pages = paginate(applied.words, captions.pacing, effectivePreset(captions).wordsPerPage, applied.breakBefore, CAPTION_MAX_CHARS_PER_LINE, CAPTION_MAX_VISUAL_LINES);
  let cursor = 0;
  return pages.map((page) => {
    const wordRefs = applied.wordRefs.slice(cursor, cursor + page.words.length);
    const srcIdxs = applied.indices.slice(cursor, cursor + page.words.length).filter((index) => index >= 0);
    cursor += page.words.length;
    return { id: pageId('single', wordRefs, page), laneId: 'single', laneOrder: 0, page, srcIdxs, wordRefs, manual: false };
  });
}

export function activeCaptionPages(pages: readonly CaptionPageIdentity[], ms: number): CaptionPageIdentity[] {
  const byLane = new Map<string, CaptionPageIdentity[]>();
  for (const page of pages) byLane.set(page.laneId, [...(byLane.get(page.laneId) ?? []), page]);
  return [...byLane.values()].flatMap((lane) => {
    if (lane[0]?.manual) {
      const active = [...lane].reverse().find((candidate) => ms >= candidate.page.start && ms < candidate.page.end);
      return active ? [active] : [];
    }
    const active = activePage(lane.map((candidate) => candidate.page), ms);
    const identity = active && lane.find((candidate) => candidate.page === active);
    return identity ? [identity] : [];
  }).sort((left, right) => left.laneOrder - right.laneOrder || left.id.localeCompare(right.id));
}
