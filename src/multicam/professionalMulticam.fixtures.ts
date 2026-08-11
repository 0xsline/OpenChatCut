import type { TimelineItem, TimelineState } from '../editor/types';

export const video = (id: string, track: string, startFrame: number, src: string): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames: 120,
  name: id,
  kind: 'video',
  src,
  srcInFrame: 0,
});

export const timeline = (items: TimelineItem[]): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  trackOrder: ['v1', 'v2'],
  tracks: { v1: { kind: 'video' }, v2: { kind: 'video' } },
  selectedId: null,
  selectedIds: [],
});

let sequence = 0;
export const makeId = () => `generated_${++sequence}`;
