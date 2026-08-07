import type { MediaAsset } from '../../editor/types';
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

export function validateSourceWindow(
  type: string,
  asset: MediaAsset,
  fps: number,
  entry: Record<string, unknown>,
  durationInFrames: number | undefined,
): OpResult | null {
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
