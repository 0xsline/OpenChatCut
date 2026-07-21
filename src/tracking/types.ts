export interface TrackingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackingPoint {
  /** Frame relative to the tracked timeline clip. */
  frame: number;
  /** Target center in normalized source-media coordinates. */
  x: number;
  y: number;
  confidence: number;
}

export interface TrackingResult {
  points: TrackingPoint[];
  averageConfidence: number;
  processedFrames: number;
  totalFrames: number;
  videoWidth: number;
  videoHeight: number;
  stoppedBecauseLost: boolean;
}

export interface TrackingProgress {
  processedFrames: number;
  totalFrames: number;
  confidence: number | null;
}

export interface TrackingRequest {
  src: string;
  fps: number;
  srcInFrame: number;
  durationInFrames: number;
  playbackRate: number;
  region: TrackingRegion;
  minConfidence?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TrackingProgress) => void;
}

export interface GrayTemplate {
  width: number;
  height: number;
  sampleStep: number;
  offsets: Uint32Array;
  centered: Float32Array;
  norm: number;
}

export interface MatchResult {
  x: number;
  y: number;
  confidence: number;
}

export type TrackingErrorCode = 'load-failed' | 'seek-failed' | 'flat-target' | 'invalid-region';

export class TrackingError extends Error {
  readonly code: TrackingErrorCode;

  constructor(code: TrackingErrorCode) {
    super(code);
    this.code = code;
    this.name = 'TrackingError';
  }
}
