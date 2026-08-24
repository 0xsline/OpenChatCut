import type { MediaAsset, TimelineItem } from '../../editor/types';
import { sourceFramesToTimelineFrames } from '../../editor/sourceLimit';
import { hasOperationalTranscript } from '../../transcript/types';

type OpResult = Record<string, unknown>;
type SourceBound = { value?: number; error?: string };

const finiteNum = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function sourceBound(
  entry: Record<string, unknown>,
  secondsKey: 'sourceStartSeconds' | 'sourceEndSeconds',
  millisecondsKey: 'sourceStartMs' | 'sourceEndMs',
): SourceBound {
  const secondsRaw = entry[secondsKey];
  const millisecondsRaw = entry[millisecondsKey];
  if (secondsRaw !== undefined && millisecondsRaw !== undefined) {
    return { error: `use either ${secondsKey} or ${millisecondsKey}, not both` };
  }
  const raw = secondsRaw ?? millisecondsRaw;
  if (raw === undefined) return {};
  const parsed = finiteNum(raw);
  if (parsed === undefined) {
    return { error: `${secondsRaw !== undefined ? secondsKey : millisecondsKey} must be a finite number` };
  }
  const value = millisecondsRaw !== undefined ? parsed / 1000 : parsed;
  return value >= 0
    ? { value }
    : { error: `${secondsRaw !== undefined ? secondsKey : millisecondsKey} must be non-negative` };
}

export function validateSourceFrameUpdate(
  item: TimelineItem,
  entry: Record<string, unknown>,
): OpResult {
  const sourceStart = finiteNum(entry.sourceStartFrame);
  const srcInFrame = finiteNum(entry.srcInFrame);
  const sourceDuration = finiteNum(entry.sourceDurationInFrames);
  const duration = finiteNum(entry.durationInFrames);
  if (entry.sourceStartFrame !== undefined && (sourceStart === undefined || sourceStart < 0)) {
    return { error: 'sourceStartFrame must be a finite non-negative frame count' };
  }
  if (entry.srcInFrame !== undefined && srcInFrame === undefined) {
    return { error: 'srcInFrame must be a finite number' };
  }
  if (sourceStart !== undefined && srcInFrame !== undefined
    && Math.round(sourceStart) !== Math.round(srcInFrame)) {
    return { error: 'srcInFrame and sourceStartFrame must match when both are provided' };
  }
  if (entry.sourceDurationInFrames !== undefined && (sourceDuration === undefined || sourceDuration <= 0)) {
    return { error: 'sourceDurationInFrames must be a finite positive frame count' };
  }
  if (entry.durationInFrames !== undefined && duration === undefined) {
    return { error: 'durationInFrames must be a finite number' };
  }
  if (sourceDuration !== undefined && duration !== undefined) {
    return { error: 'use sourceDurationInFrames or durationInFrames, not both' };
  }
  if ((sourceStart !== undefined || sourceDuration !== undefined)
    && item.kind !== 'video' && item.kind !== 'audio') {
    return { error: `source frame windows only apply to video/audio clips (got ${item.kind})` };
  }
  if ((sourceStart !== undefined || sourceDuration !== undefined)
    && item.kind === 'audio' && hasOperationalTranscript(item)) {
    return { error: 'raw source-frame windows are unsupported for audio with an operational transcript' };
  }
  const requestedStart = sourceStart ?? srcInFrame;
  return {
    ...(requestedStart !== undefined ? { srcInFrame: Math.max(0, Math.round(requestedStart)) } : {}),
    ...(sourceDuration !== undefined
      ? { durationInFrames: Math.max(1, Math.round(sourceFramesToTimelineFrames(item, sourceDuration))) }
      : duration !== undefined ? { durationInFrames: Math.max(1, Math.round(duration)) } : {}),
  };
}

export function validateSourceWindow(
  type: string,
  asset: MediaAsset,
  fps: number,
  entry: Record<string, unknown>,
  durationInFrames: number | undefined,
): OpResult | null {
  const frameStartRaw = entry.sourceStartFrame;
  const frameDurationRaw = entry.sourceDurationInFrames;
  const usesFrameWindow = frameStartRaw !== undefined || frameDurationRaw !== undefined;
  const usesTimeWindow = entry.sourceStartSeconds !== undefined || entry.sourceEndSeconds !== undefined
    || entry.sourceStartMs !== undefined || entry.sourceEndMs !== undefined;
  if (usesFrameWindow && usesTimeWindow) {
    return { error: 'use frame source windows or seconds/milliseconds source windows, not both' };
  }
  if (usesFrameWindow) {
    const sourceStartFrame = frameStartRaw === undefined ? 0 : finiteNum(frameStartRaw);
    const sourceDurationInFrames = frameDurationRaw === undefined ? undefined : finiteNum(frameDurationRaw);
    if (sourceStartFrame === undefined || sourceStartFrame < 0) {
      return { error: 'sourceStartFrame must be a finite non-negative frame count' };
    }
    if (sourceDurationInFrames !== undefined && sourceDurationInFrames <= 0) {
      return { error: 'sourceDurationInFrames must be a finite positive frame count' };
    }
    if (durationInFrames !== undefined || entry.srcInFrame !== undefined) {
      return { error: 'do not combine source frame windows with durationInFrames/srcInFrame' };
    }
    if (type !== 'video' && type !== 'audio') {
      return { error: `source frame windows only apply to video/audio adds (got ${type})` };
    }
    if (type === 'audio' && hasOperationalTranscript(asset)) {
      return { error: 'raw source-frame windows are unsupported for audio with an operational transcript' };
    }
    const startFrameIn = Math.round(sourceStartFrame);
    const available = asset.durationInFrames > 0 ? asset.durationInFrames - startFrameIn : null;
    if (available !== null && available <= 0) {
      return { error: `sourceStartFrame ${startFrameIn} is past the end of asset ${asset.id}` };
    }
    const sourceFrames = sourceDurationInFrames === undefined
      ? available
      : Math.round(sourceDurationInFrames);
    if (sourceFrames === null) return { error: 'sourceDurationInFrames is required when the asset duration is unknown' };
    if (available !== null && sourceFrames > available) {
      return { error: `source frame window exceeds asset ${asset.id} length ${asset.durationInFrames}` };
    }
    return {
      srcInFrame: startFrameIn,
      durationInFrames: Math.max(1, sourceFrames),
      sourceRange: {
        startFrame: startFrameIn,
        durationInFrames: Math.max(1, sourceFrames),
        endFrameExclusive: startFrameIn + Math.max(1, sourceFrames),
      },
    };
  }
  const start = sourceBound(entry, 'sourceStartSeconds', 'sourceStartMs');
  const end = sourceBound(entry, 'sourceEndSeconds', 'sourceEndMs');
  if (start.error || end.error) return { error: start.error ?? end.error };
  if (start.value === undefined && end.value === undefined) return null;
  if (type !== 'video' && type !== 'audio' && type !== 'gif') {
    return { error: `source windows only apply to video/audio/gif adds (got ${type})` };
  }
  if (type === 'gif') {
    return {
      error: 'GIF source windows are unsupported because GIF playback does not consume srcInFrame; convert the GIF to video for source trimming',
    };
  }
  if (type === 'audio' && hasOperationalTranscript(asset)) {
    return {
      error: [
        'raw-source windows are unsupported for audio with an operational transcript',
        'transcript audio renders a packed edited stream, so raw timestamps cannot be represented safely by srcInFrame',
        'add it without sourceStart/sourceEnd and edit the transcript stream, or use a non-transcribed audio source for raw-time trimming',
      ].join('; '),
    };
  }
  if (durationInFrames !== undefined || entry.srcInFrame !== undefined) {
    return { error: 'do not combine source windows with durationInFrames/srcInFrame — the source window derives the trim and length' };
  }
  const assetFrames = asset.durationInFrames > 0 ? asset.durationInFrames : null;
  const startSec = start.value ?? 0;
  const startFrameIn = Math.round(startSec * fps);
  if (assetFrames !== null && startFrameIn >= assetFrames) {
    return { error: `source start ${startSec}s is past the end of the asset (${(assetFrames / fps).toFixed(2)}s)` };
  }
  const endSec = end.value ?? (assetFrames !== null ? assetFrames / fps : undefined);
  if (endSec === undefined) return { error: 'a source end is required when the asset duration is unknown' };
  if (endSec <= startSec) {
    return { error: `source end ${endSec}s must be greater than source start ${startSec}s` };
  }
  const endFrameIn = Math.max(startFrameIn + 1, Math.round(endSec * fps));
  if (assetFrames !== null && endFrameIn > assetFrames) {
    return { error: `source end ${endSec}s exceeds the asset length (${(assetFrames / fps).toFixed(2)}s)` };
  }
  return {
    srcInFrame: startFrameIn,
    durationInFrames: endFrameIn - startFrameIn,
    sourceRange: { startSeconds: startSec, endSeconds: endSec },
  };
}
