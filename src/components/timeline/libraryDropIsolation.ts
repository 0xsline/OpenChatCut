import { isolateVoiceOnSrc, type IsolateVoiceResult } from '../../audio/isolateVoice';
import {
  captureTimelineItemSource,
  validateTimelineItemSourceResult,
  type TimelineItemSourceStale,
} from '../../editor/mediaSourceRevision';
import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';

export type IsolateVoiceSource = (
  src: string,
  strength: number,
  options: { force: boolean; sourceRevision: string },
) => Promise<IsolateVoiceResult>;

export interface LibraryDropIsolationContext {
  getState: () => TimelineState;
  getAssets: () => readonly MediaAsset[];
  setItemDenoise: (itemId: string, denoisedSrc: string, strength: number) => void;
}

export type LibraryDropIsolationResult = TimelineItemSourceStale | {
  status: 'committed';
  itemId: string;
  denoisedSrc: string;
  strength: number;
  sourceRevision: string;
};

/**
 * Revision-aware commit boundary for the asynchronous audio-fx drop path.
 * The callback is never invoked for a missing, replaced, relinked, or
 * server-revision-mismatched item.
 */
export async function applyLibraryDropIsolation(
  item: TimelineItem,
  strength: number,
  context: LibraryDropIsolationContext,
  isolate: IsolateVoiceSource = isolateVoiceOnSrc,
): Promise<LibraryDropIsolationResult> {
  const snapshot = captureTimelineItemSource(item, context.getAssets());
  const result = await isolate(snapshot.src, strength, {
    force: true,
    sourceRevision: snapshot.sourceRevision,
  });
  const currentItem = context.getState().items.find((candidate) => candidate.id === snapshot.itemId);
  const validation = validateTimelineItemSourceResult(
    snapshot,
    currentItem,
    context.getAssets(),
    result.sourceRevision,
  );
  if (validation.status === 'stale') return validation;

  context.setItemDenoise(snapshot.itemId, result.path, result.strength);
  return {
    status: 'committed',
    itemId: snapshot.itemId,
    denoisedSrc: result.path,
    strength: result.strength,
    sourceRevision: result.sourceRevision,
  };
}
