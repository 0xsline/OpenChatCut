import type { TimelineItem } from '../editor/types';
import type { CaptionStyle, CaptionStyleOverride } from './styles';
import { buildCues, cueTextPatch, type CueRow } from './captionCues';
import { buildLaneGroups } from './lanes';
import { isManualCaptionEntry, removeManualCue, updateManualCue } from './manualCaptions';
import { effectivePreset } from './renderStyles';
import type { CaptionLayout, CaptionsData } from './types';

const LINGER_MS = 1_500;

interface PreviewCue {
  text: string;
  start: number;
  end: number;
}

interface BaseTarget {
  key: string;
  cue: PreviewCue;
  preset: CaptionStyle;
  layout?: CaptionLayout;
}

export interface SingleCaptionPreviewTarget extends BaseTarget {
  kind: 'single';
  cueIndex: number;
  rows: CueRow[];
}

export interface ManualCaptionPreviewTarget extends BaseTarget {
  kind: 'manual';
  laneId: string;
  cueIndex: number;
}

export type CaptionPreviewTarget = SingleCaptionPreviewTarget | ManualCaptionPreviewTarget;
export type CaptionPreviewNudgeDirection = 'left' | 'right' | 'up' | 'down';

const NUDGE_DELTAS: Record<CaptionPreviewNudgeDirection, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const roundedRatio = (value: number): number => Math.round(value * 10_000) / 10_000;

function activeCueIndex(rows: CueRow[], ms: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (ms < rows[index]!.start) continue;
    const until = rows[index + 1]?.start ?? rows[index]!.end + LINGER_MS;
    return ms < until ? index : -1;
  }
  return -1;
}

function manualCueIndex(target: PreviewCue, words: readonly PreviewCue[]): number {
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]!;
    if (word.start === target.start && word.end === target.end && word.text === target.text) return index;
  }
  return -1;
}

function manualTarget(captions: CaptionsData, items: TimelineItem[], fps: number, ms: number): ManualCaptionPreviewTarget | null {
  const basePreset = effectivePreset(captions);
  const groups = buildLaneGroups(captions, items, fps, ms, basePreset.wordsPerPage) ?? [];
  for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const group = groups[groupIndex]!;
    for (let laneIndex = group.lanes.length - 1; laneIndex >= 0; laneIndex -= 1) {
      const lane = group.lanes[laneIndex]!;
      if (!isManualCaptionEntry(lane.entry)) continue;
      const cue = lane.page.words[0];
      if (!cue) continue;
      const cueIndex = manualCueIndex(cue, lane.entry.words ?? []);
      if (cueIndex < 0) continue;
      const layout = group.anchor
        ? {
            anchor: group.anchor,
            offsetXRatio: group.offsetXRatio,
            offsetYRatio: group.offsetYRatio,
            scale: group.scale,
            rotation: group.rotation,
            opacity: group.opacity,
          }
        : captions.layout;
      return {
        kind: 'manual', laneId: lane.entry.id, cueIndex, cue, layout,
        key: `manual:${lane.entry.id}:${cueIndex}:${cue.start}:${cue.end}`,
        preset: lane.entry.style ? { ...basePreset, ...lane.entry.style } : basePreset,
      };
    }
  }
  return null;
}

export function findCaptionPreviewTarget(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  ms: number,
  singleRows?: CueRow[],
): CaptionPreviewTarget | null {
  if (!captions.enabled) return null;
  // Manual multi-lane cues win first; otherwise fall through to the flat cue
  // path so auto multi-lane / sourceEntries tracks stay clickable on preview.
  if (captions.sourceEntries?.length) {
    const manual = manualTarget(captions, items, fps, ms);
    if (manual) return manual;
  }
  const rows = singleRows ?? buildCues(captions, items, fps);
  const cueIndex = activeCueIndex(rows, ms);
  const cue = rows[cueIndex];
  return cue
    ? { kind: 'single', key: `single:${cueIndex}:${cue.start}:${cue.end}`, cue, cueIndex, rows, preset: effectivePreset(captions), layout: captions.layout }
    : null;
}

export function captionPreviewTextPatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
  text: string,
): Partial<CaptionsData> | null {
  if (target.kind === 'single') return cueTextPatch(captions, target.rows, target.cueIndex, text);
  if (!text.trim()) return removeManualCue(captions, target.laneId, target.cueIndex);
  return updateManualCue(captions, target.laneId, target.cueIndex, text, target.cue.start, target.cue.end);
}

export function captionPreviewStylePatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
  style: CaptionStyleOverride,
): Partial<CaptionsData> {
  if (target.kind === 'single') return { styleOverride: { ...captions.styleOverride, ...style } };
  return {
    sourceEntries: captions.sourceEntries?.map((entry) => entry.id === target.laneId
      ? { ...entry, style: { ...entry.style, ...style } }
      : entry),
  };
}

export function captionPreviewStyleResetPatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
): Partial<CaptionsData> {
  if (target.kind === 'single') return { styleOverride: undefined };
  return {
    sourceEntries: captions.sourceEntries?.map((entry) => {
      if (entry.id !== target.laneId) return entry;
      const { style: _style, ...rest } = entry;
      return rest;
    }),
  };
}

export function captionPreviewLayoutPatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
  layout: CaptionLayout,
): Partial<CaptionsData> {
  const nextLayout = { ...target.layout, ...layout };
  if (target.kind === 'single') return { layout: nextLayout };
  return {
    sourceEntries: captions.sourceEntries?.map((entry) => entry.id === target.laneId
      ? {
          ...entry,
          anchor: nextLayout.anchor,
          offsetXRatio: nextLayout.offsetXRatio,
          offsetYRatio: nextLayout.offsetYRatio,
          scale: nextLayout.scale,
          rotation: nextLayout.rotation,
          opacity: nextLayout.opacity,
        }
      : entry),
  };
}

export function captionPreviewLayoutResetPatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
): Partial<CaptionsData> {
  if (target.kind === 'single') return { layout: undefined };
  return {
    sourceEntries: captions.sourceEntries?.map((entry) => {
      if (entry.id !== target.laneId) return entry;
      const {
        anchor: _anchor,
        offsetXRatio: _offsetXRatio,
        offsetYRatio: _offsetYRatio,
        scale: _scale,
        rotation: _rotation,
        opacity: _opacity,
        ...rest
      } = entry;
      return rest;
    }),
  };
}

export function captionPreviewNudgePatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
  direction: CaptionPreviewNudgeDirection,
  stepRatio = 0.01,
): Partial<CaptionsData> {
  const anchor = target.layout?.anchor ?? 'bottom-center';
  const delta = NUDGE_DELTAS[direction];
  const verticalStorageSign = anchor.startsWith('bottom') || anchor === 'bottom' ? -1 : 1;
  return captionPreviewLayoutPatch(captions, target, {
    ...target.layout,
    anchor,
    offsetXRatio: roundedRatio((target.layout?.offsetXRatio ?? 0) + delta.x * stepRatio),
    offsetYRatio: roundedRatio((target.layout?.offsetYRatio ?? 0) + delta.y * stepRatio * verticalStorageSign),
  });
}
