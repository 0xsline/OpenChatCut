import type { ExportMediaRate, ExportMediaStart } from '../../shared/export-media-sources';

export interface PremiereFrameRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly timebase: number;
  readonly ntsc: boolean;
}

export type PremiereFrameRateInput = number | ExportMediaRate;

const NTSC_RATES = [
  { timebase: 24, numerator: 24_000, denominator: 1_001 },
  { timebase: 30, numerator: 30_000, denominator: 1_001 },
  { timebase: 60, numerator: 60_000, denominator: 1_001 },
] as const;

function rationalRate(input: PremiereFrameRateInput): { numerator: number; denominator: number } {
  if (typeof input !== 'number') {
    if (!Number.isSafeInteger(input.numerator) || input.numerator <= 0
      || !Number.isSafeInteger(input.denominator) || input.denominator <= 0) {
      throw new Error('Premiere XML requires a positive rational frame rate');
    }
    return { numerator: input.numerator, denominator: input.denominator };
  }
  if (!Number.isFinite(input) || input <= 0) throw new Error('Premiere XML requires a positive frame rate');
  const ntsc = NTSC_RATES.find((rate) => Math.abs(input - rate.numerator / rate.denominator) < 0.001);
  if (ntsc) return { numerator: ntsc.numerator, denominator: ntsc.denominator };
  if (Number.isInteger(input)) return { numerator: input, denominator: 1 };
  throw new Error(`Premiere XML cannot represent the frame rate ${input}`);
}

/** Convert a rational/standard fps into XMEML's timebase + 1000/1001 flag. */
export function premiereFrameRate(input: PremiereFrameRateInput): PremiereFrameRate {
  const rate = rationalRate(input);
  const ntsc = NTSC_RATES.find((candidate) => (
    candidate.numerator * rate.denominator === rate.numerator * candidate.denominator
  ));
  if (ntsc) return { ...rate, timebase: ntsc.timebase, ntsc: true };
  if (rate.denominator === 1) return { ...rate, timebase: rate.numerator, ntsc: false };
  throw new Error(`Premiere XML cannot represent the frame rate ${rate.numerator}/${rate.denominator}`);
}

export function premiereRateXml(input: PremiereFrameRateInput, indent = ''): string {
  const rate = premiereFrameRate(input);
  return `<rate>\n${indent}  <timebase>${rate.timebase}</timebase>\n${indent}  <ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>\n${indent}</rate>`;
}

/** Round a project-frame coordinate into the exact native media frame grid. */
export function sourceFramesAtTimelineRate(
  timelineFrames: number,
  sourceRate: PremiereFrameRateInput,
  timelineRate: PremiereFrameRateInput,
): number {
  if (!Number.isFinite(timelineFrames)) throw new Error('Premiere XML received a non-finite frame coordinate');
  const source = rationalRate(sourceRate);
  const timeline = rationalRate(timelineRate);
  return Math.round(timelineFrames * source.numerator * timeline.denominator
    / (source.denominator * timeline.numerator));
}

/** Physical media frame represented by an embedded timecode start. */
export function mediaStartFrame(start: ExportMediaStart, rate: PremiereFrameRateInput): number {
  const source = rationalRate(rate);
  return Math.round(start.value * source.numerator / (start.timescale * source.denominator));
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format a physical media-frame count as SMPTE, including standard DF labels. */
export function frameCountToTimecode(frameCount: number, rate: PremiereFrameRateInput, dropFrame = false): string {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) throw new Error('Premiere XML received an invalid timecode frame');
  const exact = rationalRate(rate);
  const nominal = Math.round(exact.numerator / exact.denominator);
  let numbered = frameCount;
  if (dropFrame) {
    if ((exact.numerator !== 30_000 && exact.numerator !== 60_000) || exact.denominator !== 1_001) {
      throw new Error('Drop-frame timecode requires 29.97 or 59.94 fps media');
    }
    const droppedPerMinute = nominal / 15;
    const framesPerTenMinutes = nominal * 600 - droppedPerMinute * 9;
    const framesPerMinute = nominal * 60 - droppedPerMinute;
    const tenMinuteBlocks = Math.floor(frameCount / framesPerTenMinutes);
    const remainder = frameCount % framesPerTenMinutes;
    const extraMinutes = Math.max(0, Math.floor((remainder - droppedPerMinute) / framesPerMinute));
    numbered += droppedPerMinute * (9 * tenMinuteBlocks + extraMinutes);
  }
  const framesPerHour = nominal * 3600;
  const hours = Math.floor(numbered / framesPerHour);
  const remainderAfterHours = numbered % framesPerHour;
  const minutes = Math.floor(remainderAfterHours / (nominal * 60));
  const remainderAfterMinutes = remainderAfterHours % (nominal * 60);
  const seconds = Math.floor(remainderAfterMinutes / nominal);
  const frames = remainderAfterMinutes % nominal;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${dropFrame ? ';' : ':'}${pad(frames)}`;
}

/** Serialize a file's own embedded start; clip in/out remain relative to this origin. */
export function mediaTimecodeXml(start: ExportMediaStart | undefined, rate: PremiereFrameRateInput, indent = ''): string {
  if (!start) return '';
  const label = start.timecode ?? frameCountToTimecode(mediaStartFrame(start, rate), rate, start.dropFrame);
  const frame = mediaStartFrame(start, rate);
  const format = start.dropFrame ? 'DF' : 'NDF';
  return [
    `<timecode>`,
    `${indent}  ${premiereRateXml(rate, `${indent}  `)}`,
    `${indent}  <string>${escapeXmlText(label)}</string>`,
    `${indent}  <frame>${frame}</frame>`,
    `${indent}  <displayformat>${format}</displayformat>`,
    `${indent}</timecode>`,
  ].join('\n');
}

