// Media-pool matching and source in-point origins for timeline import.
//
// Interchange files address media by their own clock: an FCPXML asset-clip's
// `start` and an EDL's source timecode are positions on the file's embedded
// timecode (a camera file may start at 01:00:00:00 or at time of day), while an
// OpenChatCut clip's srcInFrame counts from the file's first frame. Converting
// needs the file's timecode origin, which this module resolves.
import type { MediaAsset } from '../../editor/types';
import {
  ZERO, add, cmp, formatSeconds, fromFrames, isZero, rational, sub, type Rational,
} from './timeline-import-rational';

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Comparable path/URL form: file URLs (incl. file://localhost/C:/…) and OS paths agree. */
export function normalizedReference(value: string): string {
  const slashed = value.trim().replace(/\\/g, '/');
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(slashed);
  const path = decoded(isUrl ? slashed.replace(/[?#].*$/, '') : slashed)
    .replace(/^file:\/\/(?:localhost)?(?=\/)/i, '')
    .replace(/^file:\/\//i, '//')
    .replace(/^\/([a-z]:\/)/i, '$1');
  return path.toLowerCase();
}

function basename(value: string): string {
  const normalized = normalizedReference(value).replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function assetMatchScore(asset: MediaAsset, references: readonly string[]): number {
  const exact = [asset.id, asset.src, asset.originalFilePath ?? ''].map(normalizedReference).filter(Boolean);
  const names = [asset.name, asset.sourceFilename ?? '', basename(asset.src), basename(asset.originalFilePath ?? '')]
    .map((value) => value.trim().toLowerCase()).filter(Boolean);
  let score = 0;
  for (const reference of references) {
    const normalized = normalizedReference(reference);
    if (!normalized) continue;
    if (exact.includes(normalized)) score = Math.max(score, 100);
    const file = basename(normalized);
    if (names.includes(normalized) || (file && names.includes(file))) score = Math.max(score, 50);
  }
  return score;
}

/** Best unique media-pool match for a set of references, or why there is none. */
export function resolveAsset(
  assets: readonly MediaAsset[],
  references: readonly string[],
): MediaAsset | { reason: string } {
  const scored = assets.map((asset) => ({ asset, score: assetMatchScore(asset, references) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return { reason: 'no matching media-pool asset' };
  const best = scored[0]!.score;
  const winners = scored.filter((entry) => entry.score === best);
  return winners.length === 1
    ? winners[0]!.asset
    : { reason: `ambiguous media-pool match: ${winners.slice(0, 6).map((entry) => entry.asset.id).join(', ')}` };
}

/** Pool kinds whose clips have no meaningful source in-point. */
export function isStillAsset(asset: MediaAsset): boolean {
  return asset.kind === 'image' || asset.kind === 'svg' || asset.kind === 'gif' || asset.kind === 'motion-graphic';
}

export function isTimelineAsset(asset: MediaAsset): boolean {
  return asset.kind !== 'document' && asset.kind !== 'file';
}

/** Probed length of a video/audio file in seconds, when known. */
export function assetSeconds(asset: MediaAsset, projectFps: Rational): Rational | null {
  if ((asset.kind !== 'video' && asset.kind !== 'audio') || !(asset.durationInFrames > 1)) return null;
  return fromFrames(asset.durationInFrames, projectFps);
}

export interface SourceInRequest {
  /** In-point on the media's own clock, in seconds. */
  mediaIn: Rational;
  /** Media seconds the clip plays. */
  length: Rational;
  /** FCPXML asset@start: the exporter's statement of where the file's clock begins. */
  declaredStart?: Rational;
  /** FCPXML asset@duration. */
  declaredDuration?: Rational;
  /** The FCPXML has several assets for this file: each describes only the range its clip uses. */
  rangeOnly?: boolean;
  /** HH:00:00:00 at or before mediaIn on the media clock (EDL / fallback candidate). */
  hourStart?: Rational;
  asset: MediaAsset;
  /** Frame domain of asset.durationInFrames (the project fps when the file was probed). */
  projectFps: Rational;
}

/** An assumption made about a file's timecode origin, reported once per import. */
export type SourceNote = 'range-only-asset' | 'hour-clock';

export type SourceInResult = { ok: true; in: Rational; note?: SourceNote } | { ok: false; reason: string };

// Probed container durations and an NLE's stream durations of the same file
// differ by a few frames; half a second separates them from a trimmed range.
const TOLERANCE = rational(1n, 2n);

function clockOrigin(asset: MediaAsset): Rational | null {
  const clock = asset.sourceTimecode;
  if (!clock) return null;
  return rational(BigInt(clock.frameCount) * BigInt(clock.frameRate.denominator), BigInt(clock.frameRate.numerator));
}

/**
 * File-relative in-point (seconds) for a clip addressed on the media clock.
 *
 * 1. A pool asset with a known embedded timecode (sourceTimecode) decides.
 * 2. An FCPXML asset that describes the whole file (Final Cut Pro, most
 *    Resolve exports) declares the clock origin in asset@start.
 * 3. Otherwise the origin is unknown: an EDL never states it, and DaVinci
 *    Resolve FCPXML exports may write one asset per clip whose start and
 *    duration are only the used range (several assets for one file, or an
 *    asset shorter than the probed file). The file is then assumed to have no
 *    timecode (origin 0), or a clock that starts on the hour, whichever keeps
 *    the clip inside the probed file. When neither does, the in-point is
 *    unknown and the clip is refused rather than guessed.
 */
export function resolveSourceIn(request: SourceInRequest): SourceInResult {
  const { mediaIn, length, declaredStart, declaredDuration, hourStart, asset } = request;
  if (isStillAsset(asset)) return { ok: true, in: ZERO };
  const origin = clockOrigin(asset);
  if (origin) return { ok: true, in: sub(mediaIn, origin) };
  const fileSeconds = assetSeconds(asset, request.projectFps);
  const rangeOnly = !!request.rangeOnly || (!!declaredDuration && !!fileSeconds
    && cmp(add(declaredDuration, TOLERANCE), fileSeconds) < 0);
  if (declaredStart && !rangeOnly) return { ok: true, in: sub(mediaIn, declaredStart) };
  const fits = (inPoint: Rational) => cmp(inPoint, ZERO) >= 0
    && (!fileSeconds || cmp(add(inPoint, length), add(fileSeconds, TOLERANCE)) <= 0);
  if (fits(mediaIn)) {
    return declaredStart && !isZero(declaredStart)
      ? { ok: true, in: mediaIn, note: 'range-only-asset' }
      : { ok: true, in: mediaIn };
  }
  if (hourStart && !isZero(hourStart) && fits(sub(mediaIn, hourStart))) {
    return { ok: true, in: sub(mediaIn, hourStart), note: 'hour-clock' };
  }
  const seconds = fileSeconds ? ` (${formatSeconds(fileSeconds)} long)` : '';
  return {
    ok: false,
    reason: `source timecode lies outside ${asset.name}${seconds}; set the asset's sourceTimecode (edit_asset) to the file's embedded start timecode`,
  };
}

const SOURCE_NOTE_TEXT: Record<SourceNote, string> = {
  'range-only-asset': 'assumed to have no embedded timecode, since the FCPXML describes only the ranges its clips use',
  'hour-clock': 'embedded timecode assumed to start on the hour; set the asset\'s sourceTimecode (edit_asset) if it does not',
};
const NAMED_FILES = 3;

export interface SourceNoteLog {
  add: (note: SourceNote, file: string) => void;
  /** One warning per assumption, naming the files and counting the clips it affected. */
  warnings: () => string[];
}

/** Collects origin assumptions: a Resolve export or a long EDL makes the same one for every clip. */
export function sourceNoteLog(): SourceNoteLog {
  const entries = new Map<SourceNote, { clips: number; files: Set<string> }>();
  return {
    add: (note, file) => {
      const entry = entries.get(note) ?? { clips: 0, files: new Set<string>() };
      entry.clips += 1;
      entry.files.add(file);
      entries.set(note, entry);
    },
    warnings: () => [...entries].map(([note, { clips, files }]) => {
      const names = [...files];
      const more = names.length > NAMED_FILES ? ` and ${names.length - NAMED_FILES} more files` : '';
      const count = `${clips} clip${clips === 1 ? '' : 's'}`;
      return `${names.slice(0, NAMED_FILES).join(', ')}${more} (${count}): ${SOURCE_NOTE_TEXT[note]}`;
    }),
  };
}
