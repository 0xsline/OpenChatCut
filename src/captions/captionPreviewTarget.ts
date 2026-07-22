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
        ? { anchor: group.anchor, offsetXRatio: group.offsetXRatio, offsetYRatio: group.offsetYRatio }
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
  if (captions.sourceEntries?.length) return manualTarget(captions, items, fps, ms);
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

export function captionPreviewLayoutPatch(
  captions: CaptionsData,
  target: CaptionPreviewTarget,
  layout: CaptionLayout,
): Partial<CaptionsData> {
  if (target.kind === 'single') return { layout };
  return {
    sourceEntries: captions.sourceEntries?.map((entry) => entry.id === target.laneId
      ? { ...entry, anchor: layout.anchor, offsetXRatio: layout.offsetXRatio, offsetYRatio: layout.offsetYRatio }
      : entry),
  };
}
