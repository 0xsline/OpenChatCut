import { moveItemsByDelta } from '../editor/multiSelect';
import {
  captionsOnTrack,
  defaultTrackId,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import type { CaptionsData, CaptionSourceEntry } from './types';
import { isManualCaptionEntry } from './manualCaptions';
import { captionSelectionKey, type CaptionSelectionRef } from './captionSelection';
import { buildCues } from './captionCues';
import { resolveEntryWords } from './resolve';
import { orderedCaptionSourceEntries } from './sourceOrder';

interface ManualCueLocation {
  trackId: TrackId;
  laneId: string;
  cueIndex: number;
  startMs: number;
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

export function captionSelectionMovePreviewUpdateMode(
  preview: TimelineSelectionMovePreview | null,
): 'sync' | 'batched' {
  return preview ? 'sync' : 'batched';
}

export function selectionMovePreviewDeltaForItem(
  itemId: string,
  preview: TimelineSelectionMovePreview | null,
): number {
  return preview?.itemIds.includes(itemId) ? preview.deltaFrames : 0;
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

function selectedManualCueLocations(
  state: TimelineState,
  selections: readonly CaptionSelectionRef[],
): ManualCueLocation[] {
  return selections.flatMap((selection) => {
    if (selection.kind !== 'manual' || state.tracks?.[selection.trackId]?.locked) return [];
    const captions = captionsOnTrack(state, selection.trackId);
    const lane = captions?.sourceEntries?.find(
      (entry) => entry.id === selection.laneId && isManualCaptionEntry(entry),
    );
    const cue = lane?.words?.[selection.cueIndex];
    return cue ? [{
      trackId: selection.trackId,
      laneId: selection.laneId,
      cueIndex: selection.cueIndex,
      startMs: cue.start,
    }] : [];
  });
}

function selectedAutomaticCueLocations(
  state: TimelineState,
  selections: readonly CaptionSelectionRef[],
): AutomaticCueLocation[] {
  return selections.flatMap((selection) => {
    if (selection.kind !== 'single' || state.tracks?.[selection.trackId]?.locked) return [];
    const captions = captionsOnTrack(state, selection.trackId);
    const cue = captions ? buildCues(captions, state.items, state.fps)[selection.cueIndex] : null;
    return cue?.srcIdxs.length ? [{
      trackId: selection.trackId,
      startMs: cue.start,
      srcIdxs: [...cue.srcIdxs],
    }] : [];
  });
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

/** Clamp a mixed selection with one shared delta at frame zero. */
export function clampTimelineSelectionDelta(
  state: TimelineState,
  itemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  requestedDeltaFrames: number,
): number {
  const ids = new Set(itemIds);
  const manualLocations = selectedManualCueLocations(state, captionSelections);
  const automaticLocations = selectedAutomaticCueLocations(state, captionSelections);
  let minDelta = Number.NEGATIVE_INFINITY;
  let hasMovableSelection = false;

  for (const item of state.items) {
    if (!ids.has(item.id) || state.tracks?.[item.track]?.locked) continue;
    hasMovableSelection = true;
    minDelta = Math.max(minDelta, -item.startFrame);
  }
  for (const location of [...manualLocations, ...automaticLocations]) {
    hasMovableSelection = true;
    minDelta = Math.max(minDelta, Math.ceil(-location.startMs * state.fps / 1000));
  }
  return hasMovableSelection ? Math.max(minDelta, Math.round(requestedDeltaFrames)) : 0;
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
    for (const location of locations) {
      if (location.trackId !== trackId) continue;
      for (const sourceIndex of location.srcIdxs) {
        const sourceItemId = sourceByOverrideIndex.get(sourceIndex);
        if (sourceItemId && selectedItemIds.has(sourceItemId)) continue;
        const current = wordOverrides[sourceIndex] ?? {};
        wordOverrides[sourceIndex] = {
          ...current,
          timingOffsetMs: (current.timingOffsetMs ?? 0) + deltaMs,
        };
      }
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
  const deltaFrames = clampTimelineSelectionDelta(state, itemIds, captionSelections, requestedDeltaFrames);
  const itemsMoved = moveItemsByDelta(state, [...itemIds], deltaFrames, itemTrackShift);
  const manualMoved = moveManualCaptionSelections(
    itemsMoved,
    selectedManualCueLocations(state, captionSelections),
    deltaFrames,
  );
  return moveAutomaticCaptionSelections(
    manualMoved,
    selectedAutomaticCueLocations(state, captionSelections),
    itemIds,
    deltaFrames,
  );
}
