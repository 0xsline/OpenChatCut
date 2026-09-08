import { sequenceReferenceError } from '../editor/sequenceGraph';
import { timelineDuration, type ProjectDoc } from '../editor/types';

export interface SequenceLibraryOption {
  id: string;
  name: string;
  durationInFrames: number;
  disabledReason?: string;
}

/** List presentation needs duration and edge validation, not an expanded render plan. */
export function sequenceLibraryOptions(doc: Pick<ProjectDoc, 'timelines' | 'activeTimelineId'>): SequenceLibraryOption[] {
  return [...doc.timelines].sort((a, b) => a.order - b.order).map((timeline) => ({
    id: timeline.id,
    name: timeline.name,
    durationInFrames: Math.max(1, timelineDuration(timeline)),
    disabledReason: sequenceReferenceError(doc, doc.activeTimelineId, timeline.id)?.message,
  }));
}
