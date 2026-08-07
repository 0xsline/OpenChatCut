import { buildCues, type CueRow } from './captionCues';
import type { CaptionPreviewTarget } from './captionPreviewTarget';
import { isManualCaptionEntry } from './manualCaptions';
import { effectivePreset } from './renderStyles';
import { orderedCaptionSourceEntries } from './sourceOrder';
import {
  captionsOnTrack,
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import type { CaptionsData } from './types';

export type CaptionSelectionRef =
  | { trackId: TrackId; kind: 'single'; pageId: string }
  | { trackId: TrackId; kind: 'manual'; laneId: string; cueId: string };

export interface CaptionSelectOptions {
  additive?: boolean;
  preserveWithItems?: boolean;
  toggle?: boolean;
}

export interface SelectedCaptionInspector {
  trackId: TrackId;
  captions: CaptionsData;
  target: CaptionPreviewTarget;
}

export interface ResolvedCaptionSelection extends SelectedCaptionInspector {
  selection: CaptionSelectionRef;
}

/**
 * Build only generated cues when structured manual lanes coexist with linked
 * sources. Cue source indexes are mapped back into the caption track's full
 * wordOverrides index space.
 */
function selectableAutomaticCues(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
): CueRow[] {
  return buildCues(captions, items, fps).filter((cue) => !cue.manual);
}

export function captionSelectionRef(trackId: TrackId, target: CaptionPreviewTarget): CaptionSelectionRef {
  return target.kind === 'single'
    ? { trackId, kind: 'single', pageId: target.pageId }
    : { trackId, kind: 'manual', laneId: target.laneId, cueId: target.cueId };
}

export function captionSelectionKey(selection: CaptionSelectionRef | null): string | null {
  if (!selection) return null;
  return selection.kind === 'single'
    ? `${selection.trackId}:single:${selection.pageId}`
    : `${selection.trackId}:manual:${selection.laneId}:${selection.cueId}`;
}

/** Resolve every visible caption cue whose frames intersect a marquee range. */
export function captionSelectionsInFrameRange(
  trackId: TrackId,
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  rangeStartFrame: number,
  rangeEndFrame: number,
): CaptionSelectionRef[] {
  if (!captions.enabled) return [];
  const lo = Math.min(rangeStartFrame, rangeEndFrame);
  const hi = Math.max(rangeStartFrame, rangeEndFrame);
  const candidates: Array<{
    selection: CaptionSelectionRef;
    start: number;
    end: number;
    laneOrder: number;
  }> = [];

  for (const cue of selectableAutomaticCues(captions, items, fps)) {
    candidates.push({
      selection: { trackId, kind: 'single', pageId: cue.id },
      start: cue.start,
      end: cue.end,
      laneOrder: -1,
    });
  }
  for (const [laneOrder, entry] of orderedCaptionSourceEntries(captions.sourceEntries ?? []).entries()) {
    if (!isManualCaptionEntry(entry) || entry.visible === false) continue;
    for (const cue of (entry.words ?? [])) {
      if (!cue.id) continue;
      candidates.push({
        selection: { trackId, kind: 'manual', laneId: entry.id, cueId: cue.id },
        start: cue.start,
        end: cue.end,
        laneOrder,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter(({ start, end }) => {
      const startFrame = Math.max(0, Math.round(start * fps / 1000));
      const endFrame = Math.max(startFrame + 1, Math.round(end * fps / 1000));
      return endFrame > lo && startFrame < hi;
    })
    .sort((a, b) => a.start - b.start
      || a.end - b.end
      || a.laneOrder - b.laneOrder
      || captionSelectionKey(a.selection)!.localeCompare(captionSelectionKey(b.selection)!))
    .flatMap(({ selection }) => {
      const key = captionSelectionKey(selection)!;
      if (seen.has(key)) return [];
      seen.add(key);
      return [selection];
    });
}

/** Select every visible cue on unlocked caption tracks. */
export function allCaptionSelections(state: TimelineState): CaptionSelectionRef[] {
  return timelineTrackIds(state).flatMap((trackId) => {
    if (trackKind(state, trackId) !== 'caption' || state.tracks?.[trackId]?.locked) return [];
    const captions = captionsOnTrack(state, trackId);
    return captions
      ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, 0, Number.MAX_SAFE_INTEGER)
      : [];
  });
}

export function resolveCaptionSelection(
  state: TimelineState,
  selection: CaptionSelectionRef | null,
): SelectedCaptionInspector | null {
  if (!selection) return null;
  const captions = captionsOnTrack(state, selection.trackId);
  if (!captions?.enabled) return null;
  const preset = effectivePreset(captions);

  if (selection.kind === 'single') {
    const rows = selectableAutomaticCues(captions, state.items, state.fps);
    const cueIndex = rows.findIndex((candidate) => candidate.id === selection.pageId);
    const cue = rows[cueIndex];
    return cue ? {
      trackId: selection.trackId,
      captions,
      target: {
        kind: 'single',
        key: `single:${cue.id}`,
        pageId: cue.id,
        cueIndex,
        cue,
        rows,
        preset,
        layout: captions.layout,
      },
    } : null;
  }

  const entry = captions.sourceEntries?.find((candidate) => candidate.id === selection.laneId);
  const cueIndex = entry?.words?.findIndex((candidate) => candidate.id === selection.cueId) ?? -1;
  const cue = cueIndex >= 0 ? entry?.words?.[cueIndex] : undefined;
  if (!entry || !cue) return null;
  return {
    trackId: selection.trackId,
    captions,
    target: {
      kind: 'manual',
      key: `manual:${entry.id}:${cue.id}`,
      laneId: entry.id,
      cueId: cue.id!,
      cueIndex,
      cue,
      preset: entry.style ? { ...preset, ...entry.style } : preset,
      layout: {
        ...captions.layout,
        anchor: entry.anchor ?? captions.layout?.anchor,
        offsetXRatio: entry.offsetXRatio ?? captions.layout?.offsetXRatio,
        offsetYRatio: entry.offsetYRatio ?? captions.layout?.offsetYRatio,
        scale: entry.scale ?? captions.layout?.scale,
        rotation: entry.rotation ?? captions.layout?.rotation,
        opacity: entry.opacity ?? captions.layout?.opacity,
      },
    },
  };
}

/** Resolve valid selections once, in canonical timeline track/time order. */
export function resolveOrderedCaptionSelections(
  state: TimelineState,
  selections: readonly CaptionSelectionRef[],
): ResolvedCaptionSelection[] {
  const trackOrder = new Map(timelineTrackIds(state).map((trackId, index) => [trackId, index]));
  const seen = new Set<string>();
  const resolved = selections.flatMap((selection) => {
    const key = captionSelectionKey(selection)!;
    if (seen.has(key)) return [];
    seen.add(key);
    const inspector = resolveCaptionSelection(state, selection);
    return inspector ? [{ ...inspector, selection }] : [];
  });
  return resolved.sort((a, b) => {
    const aTrack = trackOrder.get(a.trackId) ?? Number.MAX_SAFE_INTEGER;
    const bTrack = trackOrder.get(b.trackId) ?? Number.MAX_SAFE_INTEGER;
    return aTrack - bTrack
      || a.target.cue.start - b.target.cue.start
      || a.target.cue.end - b.target.cue.end
      || captionSelectionKey(a.selection)!.localeCompare(captionSelectionKey(b.selection)!);
  });
}
