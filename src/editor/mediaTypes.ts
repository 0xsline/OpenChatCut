import type { TranscriptCarrier } from '../transcript/types.js';

/** An imported media file in the project's media pool. */
export type MediaAssetKind = 'video' | 'image' | 'audio' | 'motion-graphic' | 'gif' | 'svg';

/** ingest-time ASR state on a pool asset ("upload and transcribe": transcribe is automatically triggered after ingest is dropped from the library,
 * asset marked "Transscription completed/failed"). Drives the media-pool badge + track_progress readiness. */
export type AssetTranscribeStatus = 'running' | 'done' | 'failed';

/** Exact frame rate used by source clocks (for example 30000/1001). */
export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

/**
 * Parsed source clock. `frameCount` is the normalized physical frame count;
 * `dropFrame` records how the human-readable label was encoded.
 */
export interface SourceClockMetadata {
  frameCount: number;
  frameRate: RationalFrameRate;
  dropFrame: boolean;
}

export interface MediaAsset extends TranscriptCarrier {
  id: string;
  name: string;
  /** Immutable filename captured from the source before internal UUID renaming. */
  readonly sourceFilename?: string;
  /** Desktop-only absolute source path used for NLE relinking; absent on web/mobile/generated media. */
  readonly originalFilePath?: string;
  kind: MediaAssetKind;
  src: string; // same-origin path under /media/uploads
  durationInFrames: number;
  /** Stable identity of the source bytes/representation used by derivatives. */
  sourceRevision?: string;
  /**
   * Canonical lowercase SHA-256 of the imported master bytes when known.
   * It deliberately remains the master identity when `src` points at a compatibility proxy or normalized derivative.
   */
  sourceContentHash?: string;
  /** File metadata used to deterministically derive sourceRevision when available. */
  sourceSize?: number;
  sourceModifiedAt?: number;
  /** Embedded source timecode normalized at ingest. */
  sourceTimecode?: SourceClockMetadata;
  /** Capture-device clock normalized at ingest when source timecode is absent. */
  captureClock?: SourceClockMetadata;
  width?: number;
  height?: number;
  code?: string;
  props?: Record<string, unknown>;
  /** media-pool organization only; does not affect timeline clips */
  folderId?: string;
  favorite?: boolean;
  /** Source revision captured when the current transcript was committed. */
  transcriptSourceRevision?: string;
  /** ingest ASR state; undefined = never transcribed (image/no-audio or pre-ingest). */
  transcribeStatus?: AssetTranscribeStatus;
  /** last ASR failure reason (transcribeStatus='failed'), for the pool badge tooltip. */
  transcribeError?: string;
}

/** Source replacement metadata. Presence of optional keys distinguishes preserve from explicit clearing. */
export interface MediaAssetRelinkPatch {
  src: string;
  name?: string;
  /** Total replacement-source frames, not a request to resize timeline clips. */
  durationInFrames?: number;
  width?: number;
  height?: number;
  kind?: MediaAsset['kind'];
  sourceRevision?: string;
  sourceContentHash?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
  sourceFilename?: string;
  originalFilePath?: string;
}

/** Observable outcome of an atomic media relink command. */
export type MediaRelinkResult =
  | { ok: true; changed: true }
  | { ok: false; changed: false; reason: 'no-document-change' };

/** user-created media-pool bin (manage_media_pool). Root is implicit. */
export interface MediaFolder {
  id: string;
  name: string;
  parentId?: string;
}
