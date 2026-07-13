import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { retimeWords } from '../transcript/edit';

// Resolve caption words as TIMELINE-ms words. Prefer the referenced audio item's
// transcript re-projected onto the edited timeline (captions follow deletions +
// silence compression); else shift the standalone words by the offset. Shared by
// the render layer, the translation generator, and the agent tool so all three
// agree on what text/timing the captions currently show.
export function resolveCaptionWords(captions: CaptionsData, items: TimelineItem[], fps: number): TranscriptWord[] {
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (item?.transcript?.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return retimeWords(item.transcript, del, fps, item.startFrame, { maxGapFrames: item.silenceFrames });
  }
  const offMs = ((captions.offsetFrames ?? 0) / fps) * 1000;
  return (captions.words ?? []).map((w) => ({ ...w, start: w.start + offMs, end: w.end + offMs }));
}
