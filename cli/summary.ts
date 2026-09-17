// ProjectDoc → rows for human output. Kept out of the command modules so each
// command stays a thin mapping from flags to store calls.
import type { ProjectDoc, Timeline, TimelineItem } from '../src/editor/types.ts';
import { CliError } from './errors.ts';
import { formatDuration } from './output.ts';

export interface TimelineRow {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly itemCount: number;
  readonly durationFrames: number;
  readonly duration: string;
  readonly trackSummary: string;
}

function timelineDurationFrames(timeline: Timeline): number {
  return timeline.items.reduce(
    (end, item) => Math.max(end, item.startFrame + item.durationInFrames),
    0,
  );
}

function tracksOf(timeline: Timeline): string[] {
  const order = timeline.trackOrder ?? [];
  const known = new Set(order);
  const extra = timeline.items.map((item) => item.track).filter((track) => !known.has(track));
  return [...new Set([...order, ...extra])];
}

function trackSummary(timeline: Timeline): string {
  const tracks = tracksOf(timeline);
  if (tracks.length === 0) return '-';
  return tracks
    .map((track) => {
      const count = timeline.items.filter((item) => item.track === track).length;
      return `${track}:${count}`;
    })
    .join(' ');
}

export function timelineRows(doc: ProjectDoc): TimelineRow[] {
  return doc.timelines.map((timeline) => {
    const durationFrames = timelineDurationFrames(timeline);
    return {
      id: timeline.id,
      name: timeline.name,
      active: timeline.id === doc.activeTimelineId,
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      itemCount: timeline.items.length,
      durationFrames,
      duration: formatDuration(durationFrames, timeline.fps),
      trackSummary: trackSummary(timeline),
    };
  });
}

export interface ItemRow {
  readonly id: string;
  readonly track: string;
  readonly kind: string;
  readonly name: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly duration: string;
  readonly source: string;
}

function sourceLabel(item: TimelineItem): string {
  if (item.templateId) return `template:${item.templateId}`;
  if (item.timelineId && item.kind === 'sequence') return `sequence:${item.timelineId}`;
  if (item.src) return item.src.split('/').pop() ?? item.src;
  return '-';
}

export function itemRows(timeline: Timeline, track?: string): ItemRow[] {
  return timeline.items
    .filter((item) => track === undefined || item.track === track)
    .slice()
    .sort((left, right) => (
      left.track === right.track
        ? left.startFrame - right.startFrame
        : String(left.track).localeCompare(String(right.track))
    ))
    .map((item) => ({
      id: item.id,
      track: item.track,
      kind: item.kind,
      name: item.name,
      startFrame: item.startFrame,
      durationFrames: item.durationInFrames,
      duration: formatDuration(item.durationInFrames, timeline.fps),
      source: sourceLabel(item),
    }));
}

export function activeTimelineOf(doc: ProjectDoc): Timeline {
  const active = doc.timelines.find((timeline) => timeline.id === doc.activeTimelineId);
  const timeline = active ?? doc.timelines[0];
  if (!timeline) throw new CliError('This project has no timeline; open it once in the app.');
  return timeline;
}
