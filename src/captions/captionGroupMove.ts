import { moveItemsByDelta } from '../editor/multiSelect';
import { moveLockedItemIds } from '../editor/linkGroups';
import {
  captionsOnTrack,
  defaultTrackId,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import type { CaptionsData, CaptionSourceEntry } from './types';
import { isManualCaptionEntry } from './manualCaptions';
import {
  captionSelectionKey,
  resolveOrderedCaptionSelections,
  type CaptionSelectionRef,
} from './captionSelection';
import { resolveEntryWords } from './resolve';
import { orderedCaptionSourceEntries } from './sourceOrder';

interface ManualCueLocation {
  trackId: TrackId;
  laneId: string;
  cueIndex: number;
  startMs: number;
  endMs: number;
}

interface AutomaticCueLocation {
  trackId: TrackId;
  startMs: number;
  srcIdxs: number[];
}

export interface TimelineSelectionMovePreview {
  itemIds: readonly string[];
  captionSelections: readonly CaptionSelectionRef[];
  deltaFrames: number;
}


export function selectionMovePreviewDeltaForItem(
  itemId: string,
  preview: TimelineSelectionMovePreview | null,
): number {
  return preview?.itemIds.includes(itemId) ? preview.deltaFrames : 0;
}

export function selectionMovePreviewDeltaForCaption(
  selection: CaptionSelectionRef | null,
  preview: TimelineSelectionMovePreview | null,
): number {
  if (!selection || !preview) return 0;
  const key = captionSelectionKey(selection);
  return preview.captionSelections.some(
    (candidate) => captionSelectionKey(candidate) === key,
  ) ? preview.deltaFrames : 0;
}

export function resolveCaptionDragSelection(
  primary: CaptionSelectionRef,
  captionSelections: readonly CaptionSelectionRef[],
  itemIds: readonly string[],
): { captionSelections: CaptionSelectionRef[]; itemIds: string[] } {
  const primaryKey = captionSelectionKey(primary);
  const insideSelection = captionSelections.some(
    (selection) => captionSelectionKey(selection) === primaryKey,
  );
  return insideSelection
    ? { captionSelections: [...captionSelections], itemIds: [...itemIds] }
    : { captionSelections: [primary], itemIds: [] };
}

export function captionDragMoveMode(
  primary: CaptionSelectionRef,
  selection: { captionSelections: readonly CaptionSelectionRef[]; itemIds: readonly string[] },
): 'timeline-selection' | 'manual-cue' {
  return primary.kind === 'single'
    || selection.captionSelections.length > 1
    || selection.itemIds.length > 0
    ? 'timeline-selection'
    : 'manual-cue';
}

export function captionSelectionsForItemDrag(
  itemWasSelected: boolean,
  captionSelections: readonly CaptionSelectionRef[],
): CaptionSelectionRef[] {
  return itemWasSelected ? [...captionSelections] : [];
}

export function resolveItemDragSelection(
  primaryItemId: string,
  selectedItemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  options?: {
    shiftKey: boolean;
    anchorItemId: string | null;
    items: TimelineState['items'];
  },
): { captionSelections: CaptionSelectionRef[]; itemIds: string[] } {
  if (options?.shiftKey && options.anchorItemId) {
    const anchor = options.items.find((item) => item.id === options.anchorItemId);
    const target = options.items.find((item) => item.id === primaryItemId);
    if (anchor && target && anchor.track === target.track) {
      const lo = Math.min(anchor.startFrame, target.startFrame);
      const hi = Math.max(anchor.startFrame, target.startFrame);
      return {
        captionSelections: [...captionSelections],
        itemIds: options.items
          .filter((item) => item.track === anchor.track && item.startFrame >= lo && item.startFrame <= hi)
          .map((item) => item.id),
      };
    }
  }
  return selectedItemIds.includes(primaryItemId)
    ? { captionSelections: [...captionSelections], itemIds: [...selectedItemIds] }
    : { captionSelections: [], itemIds: [primaryItemId] };
}

function selectedCueLocations(
  state: TimelineState,
  selections: readonly CaptionSelectionRef[],
): { manual: ManualCueLocation[]; automatic: AutomaticCueLocation[] } {
  const manual: ManualCueLocation[] = [];
  const automatic: AutomaticCueLocation[] = [];
  for (const resolved of resolveOrderedCaptionSelections(state, selections)) {
    if (state.tracks?.[resolved.trackId]?.locked) continue;
    if (resolved.target.kind === 'manual') {
      manual.push({
        trackId: resolved.trackId,
        laneId: resolved.target.laneId,
        cueIndex: resolved.target.cueIndex,
        startMs: resolved.target.cue.start,
        endMs: resolved.target.cue.end,
      });
    } else {
      const cue = resolved.target.rows[resolved.target.cueIndex];
      if (!cue?.srcIdxs.length) continue;
      automatic.push({
        trackId: resolved.trackId,
        startMs: resolved.target.cue.start,
        srcIdxs: [...cue.srcIdxs],
      });
    }
  }
  return { manual, automatic };
}

function selectedCueIndexesByLane(locations: readonly ManualCueLocation[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const location of locations) {
    const key = `${location.trackId}\u0000${location.laneId}`;
    const indexes = result.get(key) ?? new Set<number>();
    indexes.add(location.cueIndex);
    result.set(key, indexes);
  }
  return result;
}

function automaticCaptionSourceByOverrideIndex(
  captions: CaptionsData,
  state: TimelineState,
): Map<number, string> {
  if (captions.sourceEntries?.length) {
    const words = orderedCaptionSourceEntries(captions.sourceEntries)
      .filter((entry) => entry.visible !== false)
      .flatMap((entry) => resolveEntryWords(entry, state.items, state.fps)
        .map((word) => ({ word, itemId: entry.itemId })))
      .sort((a, b) => a.word.start - b.word.start || a.word.end - b.word.end);
    return new Map(words.map((word, index) => [index, word.itemId]));
  }

  if (captions.sourceItemId) {
    const source = state.items.find((item) => item.id === captions.sourceItemId);
    return new Map((source?.transcript ?? []).map((_, index) => [index, captions.sourceItemId!]));
  }

  let sourceItems: TimelineState['items'] = [];
  if (captions.sourceMode === 'timeline') {
    sourceItems = state.items
      .filter((item) => item.transcript?.length)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  } else if (captions.sources?.length) {
    sourceItems = captions.sources
      .map((id) => state.items.find((item) => item.id === id))
      .filter((item): item is TimelineState['items'][number] => !!item?.transcript?.length);
  }

  const words = sourceItems
    .flatMap((item) => resolveEntryWords(
      { id: `source:${item.id}`, itemId: item.id },
      state.items,
      state.fps,
    ).map((word) => ({ word, itemId: item.id })))
    .sort((a, b) => a.word.start - b.word.start);
  return new Map(words.map((word, index) => [index, word.itemId]));
}

function earliestPersistableDeltaFrames(startMs: number, fps: number): number {
  let deltaFrames = -Math.ceil(Math.max(0, startMs) * fps / 1000);
  while (startMs + Math.round(deltaFrames * 1000 / fps) < 0) deltaFrames += 1;
  while (startMs + Math.round((deltaFrames - 1) * 1000 / fps) >= 0) deltaFrames -= 1;
  return deltaFrames;
}

function latestPersistableDeltaFrames(deltaMs: number, fps: number): number {
  let deltaFrames = Math.floor(Math.max(0, deltaMs) * fps / 1000);
  while (Math.round((deltaFrames + 1) * 1000 / fps) <= deltaMs) deltaFrames += 1;
  while (Math.round(deltaFrames * 1000 / fps) > deltaMs) deltaFrames -= 1;
  return deltaFrames;
}

function manualSelectionDeltaBounds(
  state: TimelineState,
  locations: readonly ManualCueLocation[],
): { minFrames: number; maxFrames: number } {
  const selectedByLane = selectedCueIndexesByLane(locations);
  let minDeltaMs = Number.NEGATIVE_INFINITY;
  let maxDeltaMs = Number.POSITIVE_INFINITY;

  for (const location of locations) {
    const laneKey = `${location.trackId}\u0000${location.laneId}`;
    const selectedIndexes = selectedByLane.get(laneKey);
    const captions = captionsOnTrack(state, location.trackId);
    const lane = captions?.sourceEntries?.find(
      (entry) => entry.id === location.laneId && isManualCaptionEntry(entry),
    );
    if (!selectedIndexes || !lane?.words) continue;
    for (const [index, word] of lane.words.entries()) {
      if (selectedIndexes.has(index)) continue;
      if (word.end <= location.startMs) {
        minDeltaMs = Math.max(minDeltaMs, word.end - location.startMs);
      }
      if (word.start >= location.endMs) {
        maxDeltaMs = Math.min(maxDeltaMs, word.start - location.endMs);
      }
    }
  }

  return {
    minFrames: Number.isFinite(minDeltaMs)
      ? earliestPersistableDeltaFrames(-minDeltaMs, state.fps)
      : Number.NEGATIVE_INFINITY,
    maxFrames: Number.isFinite(maxDeltaMs)
      ? latestPersistableDeltaFrames(maxDeltaMs, state.fps)
      : Number.POSITIVE_INFINITY,
  };
}

/** Clamp a mixed selection with one shared delta at frame zero. */
export function clampTimelineSelectionDelta(
  state: TimelineState,
  itemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  requestedDeltaFrames: number,
): number {
  const expandedItemIds = moveLockedItemIds(state, itemIds);
  const ids = new Set(expandedItemIds);
  if (expandedItemIds.some((id) => {
    const item = state.items.find((candidate) => candidate.id === id);
    return item ? state.tracks?.[item.track]?.locked : false;
  })) return 0;
  const locations = selectedCueLocations(state, captionSelections);
  const manualBounds = manualSelectionDeltaBounds(state, locations.manual);
  const manualLocations = locations.manual;
  const automaticLocations = locations.automatic;
  let minDelta = manualBounds.minFrames;
  let maxDelta = manualBounds.maxFrames;
  let hasMovableSelection = false;

  for (const item of state.items) {
    if (!ids.has(item.id) || state.tracks?.[item.track]?.locked) continue;
    hasMovableSelection = true;
    minDelta = Math.max(minDelta, -item.startFrame);
  }
  for (const location of [...manualLocations, ...automaticLocations]) {
    hasMovableSelection = true;
    minDelta = Math.max(minDelta, earliestPersistableDeltaFrames(location.startMs, state.fps));
  }
  return hasMovableSelection
    ? Math.min(maxDelta, Math.max(minDelta, Math.round(requestedDeltaFrames)))
    : 0;
}

function moveAutomaticCaptionSelections(
  state: TimelineState,
  locations: readonly AutomaticCueLocation[],
  itemIds: readonly string[],
  deltaFrames: number,
): TimelineState {
  if (!locations.length || deltaFrames === 0) return state;
  const deltaMs = Math.round(deltaFrames * 1000 / state.fps);
  const selectedItemIds = new Set(itemIds);
  let next = state;
  for (const trackId of new Set(locations.map((location) => location.trackId))) {
    const captions = captionsOnTrack(next, trackId);
    if (!captions) continue;
    const sourceByOverrideIndex = automaticCaptionSourceByOverrideIndex(captions, state);
    const wordOverrides = { ...(captions.wordOverrides ?? {}) };
    const sourceIndexes = new Set(locations
      .filter((location) => location.trackId === trackId)
      .flatMap((location) => location.srcIdxs));
    for (const sourceIndex of sourceIndexes) {
      const sourceItemId = sourceByOverrideIndex.get(sourceIndex);
      if (sourceItemId && selectedItemIds.has(sourceItemId)) continue;
      const current = wordOverrides[sourceIndex] ?? {};
      wordOverrides[sourceIndex] = {
        ...current,
        timingOffsetMs: (current.timingOffsetMs ?? 0) + deltaMs,
      };
    }
    next = withCaptionTrack(next, trackId, { ...captions, wordOverrides });
  }
  return next;
}

function moveManualCaptionSelections(
  state: TimelineState,
  locations: readonly ManualCueLocation[],
  deltaFrames: number,
): TimelineState {
  if (!locations.length || deltaFrames === 0) return state;
  const deltaMs = Math.round(deltaFrames * 1000 / state.fps);
  const byTrackLane = selectedCueIndexesByLane(locations);
  let next = state;

  for (const trackId of new Set(locations.map((location) => location.trackId))) {
    const captions = captionsOnTrack(next, trackId);
    if (!captions) continue;
    const sourceEntries = (captions.sourceEntries ?? []).map((entry): CaptionSourceEntry => {
      if (!isManualCaptionEntry(entry)) return entry;
      const indexes = byTrackLane.get(`${trackId}\u0000${entry.id}`);
      if (!indexes?.size) return entry;
      return {
        ...entry,
        words: (entry.words ?? []).map((word, index) => indexes.has(index)
          ? { ...word, start: word.start + deltaMs, end: word.end + deltaMs }
          : word),
      };
    });
    next = withCaptionTrack(next, trackId, { ...captions, sourceEntries });
  }
  return next;
}

function withCaptionTrack(state: TimelineState, trackId: TrackId, captions: CaptionsData): TimelineState {
  const current = state.tracks?.[trackId] ?? { kind: 'caption' as const };
  const next = { ...state, tracks: { ...state.tracks, [trackId]: { ...current, captions } } };
  return trackId === defaultTrackId(state, 'caption') ? { ...next, captions } : next;
}

/** Move selected clips and caption cues as one immutable timeline state change. */
export function moveTimelineSelectionByDelta(
  state: TimelineState,
  itemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  requestedDeltaFrames: number,
  itemTrackShift: { from: TrackId; to: TrackId } | null = null,
): TimelineState {
  const expandedItemIds = moveLockedItemIds(state, itemIds);
  const locations = selectedCueLocations(state, captionSelections);
  const deltaFrames = clampTimelineSelectionDelta(state, expandedItemIds, captionSelections, requestedDeltaFrames);
  const itemsMoved = moveItemsByDelta(state, expandedItemIds, deltaFrames, itemTrackShift);
  const manualMoved = moveManualCaptionSelections(
    itemsMoved,
    locations.manual,
    deltaFrames,
  );
  return moveAutomaticCaptionSelections(
    manualMoved,
    locations.automatic,
    expandedItemIds,
    deltaFrames,
  );
}
