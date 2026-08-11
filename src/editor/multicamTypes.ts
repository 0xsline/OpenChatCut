import type { TimelineItem } from './clipTypes.js';

export type TimelineLinkMode = 'linked' | 'sync-lock';

/** Linked A/V or sync-lock membership. Offsets are defined by the anchor item. */
export interface TimelineLinkGroup {
  id: string;
  itemIds: string[];
  anchorItemId: string;
  mode: TimelineLinkMode;
}

export type MulticamMicRole = 'program' | 'reference' | 'camera' | 'scratch' | 'none';
export type MulticamSyncMethod = 'source-timecode' | 'capture-clock' | 'audio';

export interface MulticamSyncEvidence {
  angleId: string;
  method: MulticamSyncMethod;
  confidence: number;
  offsetFrames: number;
  referenceClockFrame?: number;
  angleClockFrame?: number;
  lagSeconds?: number;
}

export interface MulticamAngle {
  id: string;
  /** Current/original item id; split descendants retain id via multicamAngleId. */
  itemId: string;
  /** Immutable aligned source snapshot used to restore a previously switched-out range. */
  source: TimelineItem;
  label: string;
  micRole?: MulticamMicRole;
  offsetFrames: number;
  confidence: number;
}

/** One non-destructive editorial decision over a right-open timeline range. */
export interface MulticamAngleDecision {
  id: string;
  fromFrame: number;
  toFrame: number;
  angleId: string;
}

export interface MulticamGroup {
  id: string;
  referenceAngleId: string;
  masterAngleId: string;
  angles: MulticamAngle[];
  syncMethod: MulticamSyncMethod;
  evidence: MulticamSyncEvidence[];
  decisions?: MulticamAngleDecision[];
}
