// Exact rational seconds for timeline interchange math.
//
// FCPXML expresses every time as a rational number of seconds with a 64-bit
// numerator and a 32-bit denominator ("1001/30000s", "86486400/24000s"), and
// converting a nested clip to sequence time adds and subtracts several of them
// (parent offset, parent start, sequence tcStart, asset start). Doing that in
// floating point drifts by a frame on long NTSC timelines, so the importer keeps
// times as reduced BigInt fractions and rounds to frames exactly once.

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(numerator: bigint, denominator: bigint = 1n): Rational {
  if (denominator === 0n) throw new RangeError('rational with a zero denominator');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator) || 1n;
  return { n: (sign * numerator) / divisor, d: (sign * denominator) / divisor };
}

export const ZERO = rational(0n);
export const ONE = rational(1n);

export const add = (a: Rational, b: Rational): Rational => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational): Rational => rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational): Rational => rational(a.n * b.n, a.d * b.d);
export const div = (a: Rational, b: Rational): Rational => rational(a.n * b.d, a.d * b.n);
export const neg = (a: Rational): Rational => rational(-a.n, a.d);
export const isZero = (a: Rational): boolean => a.n === 0n;

export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

export const min = (a: Rational, b: Rational): Rational => (cmp(a, b) <= 0 ? a : b);
export const max = (a: Rational, b: Rational): Rational => (cmp(a, b) >= 0 ? a : b);

export function toNumber(a: Rational): number {
  return Number(a.n) / Number(a.d);
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return (numerator % denominator !== 0n) && ((numerator < 0n) !== (denominator < 0n))
    ? quotient - 1n
    : quotient;
}

/** Math.round semantics (halves round up) without leaving exact arithmetic. */
export function roundToInt(a: Rational): number {
  return Number(floorDiv(2n * a.n + a.d, 2n * a.d));
}

export function floorToInt(a: Rational): number {
  return Number(floorDiv(a.n, a.d));
}

/** Seconds → nearest frame at an exact frame rate. */
export function toFrames(seconds: Rational, fps: Rational): number {
  return roundToInt(mul(seconds, fps));
}

export function fromFrames(frames: number, fps: Rational): Rational {
  return div(rational(BigInt(Math.round(frames))), fps);
}

const MAX_DIGITS = 30;

/**
 * Parse an FCPXML time value: "N/Ds", "Ns", or a decimal "N.Fs" (written by
 * some third-party tools). Returns null for anything else so callers can
 * report the attribute instead of silently treating it as zero.
 */
export function parseTime(value: string | null | undefined): Rational | null {
  const text = value?.trim() ?? '';
  const fraction = /^(-?\d+)(?:\/(\d+))?s$/.exec(text);
  if (fraction) {
    if (fraction[1]!.length > MAX_DIGITS || (fraction[2]?.length ?? 0) > MAX_DIGITS) return null;
    const denominator = BigInt(fraction[2] ?? '1');
    return denominator === 0n ? null : rational(BigInt(fraction[1]!), denominator);
  }
  const decimal = /^(-?)(\d+)\.(\d+)s$/.exec(text);
  if (decimal && decimal[2]!.length + decimal[3]!.length <= MAX_DIGITS) {
    const numerator = BigInt(`${decimal[1]}${decimal[2]}${decimal[3]}`);
    return rational(numerator, 10n ** BigInt(decimal[3]!.length));
  }
  return null;
}

// NTSC rates are stored as JS numbers on timelines (30000/1001 → 29.97002997…);
// map them back to their exact fraction so frame math stays exact.
const NTSC_RATES = [24000n, 30000n, 48000n, 60000n, 120000n].map((numerator) => rational(numerator, 1001n));

/** Exact frame rate for a timeline fps number (integer, NTSC, or millisecond-precision). */
export function rateFromNumber(fps: number): Rational {
  if (Number.isInteger(fps)) return rational(BigInt(fps));
  const ntsc = NTSC_RATES.find((rate) => Math.abs(toNumber(rate) - fps) < 0.0005);
  return ntsc ?? rational(BigInt(Math.round(fps * 1000)), 1000n);
}

/** Readable seconds for reports, e.g. "3603.6s". */
export function formatSeconds(a: Rational): string {
  return `${Number(toNumber(a).toFixed(3))}s`;
}
