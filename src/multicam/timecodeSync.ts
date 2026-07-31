import type {
  MediaAsset, MulticamSyncEvidence, MulticamSyncMethod, SourceClockMetadata, TimelineItem,
} from '../editor/types';
import {
  sourceClockFrameAtItemIn,
  sourceClockOffsetInTimelineFrames,
  type TimelineFrameRate,
} from '../editor/timecode';
import { sourceFramesToTimelineFrames } from '../editor/sourceLimit';

export interface ClockSyncPlacement {
  method: Extract<MulticamSyncMethod, 'source-timecode' | 'capture-clock'>;
  startFrame: number;
  offsetFrames: number;
  confidence: number;
  evidence: Omit<MulticamSyncEvidence, 'angleId'>;
}

function assetForItem(item: TimelineItem, assets: readonly MediaAsset[] | undefined): MediaAsset | undefined {
  return item.src ? assets?.find((asset) => asset.src === item.src) : undefined;
}

function itemClockFrame(
  clock: SourceClockMetadata,
  item: TimelineItem,
  timelineRate: TimelineFrameRate,
): number {
  return sourceClockFrameAtItemIn(clock, item, timelineRate);
}

function placementFor(
  method: ClockSyncPlacement['method'],
  referenceClock: SourceClockMetadata,
  followerClock: SourceClockMetadata,
  reference: TimelineItem,
  follower: TimelineItem,
  timelineRate: TimelineFrameRate,
): ClockSyncPlacement {
  const referenceClockFrame = itemClockFrame(referenceClock, reference, timelineRate);
  const angleClockFrame = itemClockFrame(followerClock, follower, timelineRate);
  const clockOffsetInProjectFrames = sourceClockOffsetInTimelineFrames(
    { ...referenceClock, frameCount: referenceClockFrame },
    { ...followerClock, frameCount: angleClockFrame },
    timelineRate,
  );
  const offsetFrames = Math.round(sourceFramesToTimelineFrames(reference, clockOffsetInProjectFrames));
  const startFrame = reference.startFrame + offsetFrames;
  const confidence = method === 'source-timecode' ? 1 : 0.95;
  return {
    method,
    startFrame,
    offsetFrames,
    confidence,
    evidence: {
      method,
      confidence,
      offsetFrames,
      referenceClockFrame,
      angleClockFrame,
    },
  };
}

/** Prefer source timecode, then capture clock. Undefined means audio must be tried. */
export function clockSyncPlacement(
  reference: TimelineItem,
  follower: TimelineItem,
  assets: readonly MediaAsset[] | undefined,
  timelineRate: TimelineFrameRate,
): ClockSyncPlacement | undefined {
  const referenceAsset = assetForItem(reference, assets);
  const followerAsset = assetForItem(follower, assets);
  if (!referenceAsset || !followerAsset) return undefined;
  if (referenceAsset.sourceTimecode && followerAsset.sourceTimecode) {
    return placementFor(
      'source-timecode', referenceAsset.sourceTimecode, followerAsset.sourceTimecode,
      reference, follower, timelineRate,
    );
  }
  if (referenceAsset.captureClock && followerAsset.captureClock) {
    return placementFor(
      'capture-clock', referenceAsset.captureClock, followerAsset.captureClock,
      reference, follower, timelineRate,
    );
  }
  return undefined;
}
