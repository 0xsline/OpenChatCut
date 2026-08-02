import { buildCues } from './captionCues';
import { findCaptionPreviewTarget, type CaptionPreviewTarget } from './captionPreviewTarget';
import { captionPages } from './exportCaptions';
import { effectivePreset } from './renderStyles';
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
  | { trackId: TrackId; kind: 'single'; cueIndex: number }
  | { trackId: TrackId; kind: 'manual'; laneId: string; cueIndex: number };

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

export function captionSelectionRef(trackId: TrackId, target: CaptionPreviewTarget): CaptionSelectionRef {
  return target.kind === 'single'
    ? { trackId, kind: 'single', cueIndex: target.cueIndex }
    : { trackId, kind: 'manual', laneId: target.laneId, cueIndex: target.cueIndex };
}

export function captionSelectionKey(selection: CaptionSelectionRef | null): string | null {
  if (!selection) return null;
  return selection.kind === 'single'
    ? `${selection.trackId}:single:${selection.cueIndex}`
    : `${selection.trackId}:manual:${selection.laneId}:${selection.cueIndex}`;
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
  const seen = new Set<string>();
  const selections: CaptionSelectionRef[] = [];

  for (const page of captionPages(captions, items, fps)) {
    const startFrame = Math.max(0, Math.round(page.start * fps / 1000));
    const endFrame = Math.max(startFrame + 1, Math.round(page.end * fps / 1000));
    if (endFrame <= lo || startFrame >= hi) continue;
    const target = findCaptionPreviewTarget(captions, items, fps, (page.start + page.end) / 2);
    if (!target) continue;
    const selection = captionSelectionRef(trackId, target);
    const key = captionSelectionKey(selection);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selections.push(selection);
  }
  return selections;
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
    const rows = buildCues(captions, state.items, state.fps);
    const cue = rows[selection.cueIndex];
    return cue ? {
      trackId: selection.trackId,
      captions,
      target: {
        kind: 'single',
        key: `single:${selection.cueIndex}:${cue.start}:${cue.end}`,
        cueIndex: selection.cueIndex,
        cue,
        rows,
        preset,
        layout: captions.layout,
      },
    } : null;
  }

  const entry = captions.sourceEntries?.find((candidate) => candidate.id === selection.laneId);
  const cue = entry?.words?.[selection.cueIndex];
  if (!entry || !cue) return null;
  return {
    trackId: selection.trackId,
    captions,
    target: {
      kind: 'manual',
      key: `manual:${entry.id}:${selection.cueIndex}:${cue.start}:${cue.end}`,
      laneId: entry.id,
      cueIndex: selection.cueIndex,
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
