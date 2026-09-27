// FCPXML rational time. Every FCPXML time is an exact fraction of a second
// ("N/Ds"). Media that carries a start timecode lives on its own clock: an
// asset's `start` is that timecode and a clip's `start` counts from it, so NLEs
// conform the clip against the frames the file labels. Sums and speed changes
// are computed exactly (bigint), so a clip never drifts off the file's frames.
import type { ExportMediaStart } from '../../shared/export-media-sources';

/** An exact non-negative fraction: frames or seconds. */
interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

/** Non-integer rates, fractional frames and speeds are kept to the thousandth. */
const SCALE = 1000;
/** Final Cut reads times into CMTime, whose timescale is a signed 32-bit integer. */
const MAX_TIMESCALE = 2_147_483_647n;
/** Divisible by every 24/25/30/50/60 and 1000/1001-based frame grid; used past MAX_TIMESCALE. */
const FALLBACK_TIMESCALE = 120_120_000n;

/**
 * Frame → FCPXML rational number time "N/Ds". Integer frame rate directly uses frames/fps; non-integer frame rate
 * (For example, 29.97) Amplify to the integer denominator and then round to an integer to ensure that it is exactly equivalent to frames/fps seconds——
 * Here is the simplest way to ensure accurate round-trip conversion, without pursuing NTSC 1001/30000
 * industry practice denominator. A fractional frame count is scaled the same way: "12.5/25s" is not an FCPXML time.
 */
export function rationalTime(frames: number, fps: number): string {
  if (Number.isInteger(fps) && Number.isInteger(frames)) return `${frames}/${fps}s`;
  return `${Math.round(frames * SCALE)}/${Math.round(fps * SCALE)}s`;
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  return b === 0n ? a : greatestCommonDivisor(b, a % b);
}

function reduced(num: bigint, den: bigint): Ratio {
  const divisor = greatestCommonDivisor(num, den) || 1n;
  return { num: num / divisor, den: den / divisor };
}

/** A timeline number (frames, speed) as an exact fraction, to the thousandth rationalTime keeps. */
function toRatio(value: number): Ratio {
  return Number.isInteger(value)
    ? { num: BigInt(value), den: 1n }
    : reduced(BigInt(Math.round(value * SCALE)), BigInt(SCALE));
}

/** a + b over the least common denominator, so each clock's own timescale shows through. */
function add(a: Ratio, b: Ratio): Ratio {
  if (b.num === 0n) return a;
  if (a.num === 0n) return b;
  const den = (a.den / greatestCommonDivisor(a.den, b.den)) * b.den;
  return { num: a.num * (den / a.den) + b.num * (den / b.den), den };
}

function multiply(a: Ratio, b: Ratio): Ratio {
  return reduced(a.num * b.num, a.den * b.den);
}

/** Frames at the timeline rate → seconds, on the frame grid rationalTime writes (90 frames at 30 → 90/30). */
function frameSeconds(frames: Ratio, fps: number): Ratio {
  const step = Number.isInteger(fps)
    ? { num: 1n, den: BigInt(fps) }
    : { num: BigInt(SCALE), den: BigInt(Math.round(fps * SCALE)) };
  return { num: frames.num * step.num, den: frames.den * step.den };
}

function format(time: Ratio): string {
  if (time.den <= MAX_TIMESCALE) return `${time.num}/${time.den}s`;
  const exact = reduced(time.num, time.den);
  if (exact.den <= MAX_TIMESCALE) return `${exact.num}/${exact.den}s`;
  // An exotic speed on an exotic rate: round to a sub-microsecond grid Final Cut can hold.
  return `${(exact.num * FALLBACK_TIMESCALE + exact.den / 2n) / exact.den}/${FALLBACK_TIMESCALE}s`;
}

function startRatio(start: ExportMediaStart): Ratio {
  return { num: BigInt(start.value), den: BigInt(start.timescale) };
}

/** An asset's `start`: its embedded start timecode, else "0s". */
export function mediaStartTime(start: ExportMediaStart | undefined): string {
  return start ? format(startRatio(start)) : '0s';
}

/**
 * The media position `frames` (at the timeline rate) past the file's own
 * start, in the asset's time: what a clip `start` holds. Without a start and
 * for a plain frame count this is exactly rationalTime(frames, fps).
 */
export function mediaTime(start: ExportMediaStart | undefined, frames: number | Ratio, fps: number): string {
  if (!start && typeof frames === 'number') return rationalTime(frames, fps);
  const offset = frameSeconds(typeof frames === 'number' ? toRatio(frames) : frames, fps);
  return format(start ? add(startRatio(start), offset) : offset);
}

export interface RetimedClipTimes {
  /** The clip `start`, in the retimed (adjusted) clock. */
  readonly start: string;
  /** First timept: the media's origin maps to itself. */
  readonly origin: string;
  /** Last timept `time` (adjusted) and `value` (media) at the clip's end. */
  readonly endTime: string;
  readonly endValue: string;
}

/**
 * Times for a constant speed change. In a timeMap `time` is the adjusted clip
 * time and `value` the original media time (FCPXML DTD; Apple's timeMap
 * reference), and a clip's `start` and `duration` are in adjusted time. Like
 * Final Cut's and Resolve's own exports, the map starts at the media's origin
 * (the asset start maps to itself), so the clip starts at origin + in-point ÷
 * speed in adjusted time, where the map samples origin + in-point: the frame
 * the timeline shows. It ends at the clip's end, where the map samples
 * origin + in-point + duration × speed.
 */
export function retimedClipTimes(
  start: ExportMediaStart | undefined,
  inFrame: number,
  durationFrames: number,
  rate: number,
  fps: number,
): RetimedClipTimes {
  const speed = toRatio(rate);
  const inPoint = toRatio(inFrame);
  const adjustedIn = multiply(inPoint, { num: speed.den, den: speed.num });
  const duration = toRatio(durationFrames);
  return {
    start: mediaTime(start, adjustedIn, fps),
    origin: mediaStartTime(start),
    endTime: mediaTime(start, add(adjustedIn, duration), fps),
    endValue: mediaTime(start, add(inPoint, multiply(duration, speed)), fps),
  };
}

/** Whether two files start at the same instant (both without a start counts as equal). */
export function sameMediaStart(a: ExportMediaStart | undefined, b: ExportMediaStart | undefined): boolean {
  if (!a || !b) return !a && !b;
  return BigInt(a.value) * BigInt(b.timescale) === BigInt(b.value) * BigInt(a.timescale);
}

/** `tcFormat` for clips of timecoded media; nothing for media without a timecode label. */
export function timecodeFormatAttr(start: ExportMediaStart | undefined): string {
  if (!start?.timecode) return '';
  return ` tcFormat="${start.dropFrame ? 'DF' : 'NDF'}"`;
}
