// FCPXML time contexts.
//
// Every story element sits in its parent's local timeline: `offset` is where it
// begins in parent time, `start` is where its own local timeline begins, and
// `duration` is its extent in parent time (Apple FCPXML reference, "Timing
// Attributes"). A child at local time u of element E therefore appears in the
// parent at E.offset + (u - E.start). Composing that step from the sequence
// down gives an affine map from any element's local time to sequence time;
// the sequence itself maps t to t - tcStart.
//
// Rate conform (<conform-rate>) scales the local timeline: media recorded at
// srcFrameRate plays one frame per timeline frame, so a local second lasts
// srcFrameRate/timelineRate parent seconds. A <timeMap> retimes it: a timept's
// `time` is the adjusted clip time and `value` the original clip time. Anchored
// children are positioned in adjusted time; contained children and the media
// stay in original time.
import {
  ONE, ZERO, add, cmp, div, max, min, mul, parseTime, rational, sub, type Rational,
} from './timeline-import-rational';
import { attr, childElements, firstChild, type XmlElement } from './timeline-import-xml';

/** parent = a + b × local, where b is parent seconds per local second. */
export interface Affine {
  readonly a: Rational;
  readonly b: Rational;
}

export interface Window {
  readonly start: Rational;
  readonly end: Rational;
}

export function applyMap(map: Affine, local: Rational): Rational {
  return add(map.a, mul(map.b, local));
}

/** Local time that lands on `parent`. */
export function unapplyMap(map: Affine, parent: Rational): Rational {
  return div(sub(parent, map.a), map.b);
}

/** outer ∘ inner: inner's local time → outer's parent time. */
export function compose(outer: Affine, inner: Affine): Affine {
  return { a: add(outer.a, mul(outer.b, inner.a)), b: mul(outer.b, inner.b) };
}

/** local u → offset + (u - start) × scale. */
export function shift(offset: Rational, start: Rational, scale: Rational = ONE): Affine {
  return { a: sub(offset, mul(start, scale)), b: scale };
}

export function intersect(window: Window, limit: Window | null): Window | null {
  const start = limit ? max(window.start, limit.start) : window.start;
  const end = limit ? min(window.end, limit.end) : window.end;
  return cmp(end, start) > 0 ? { start, end } : null;
}

interface TimePoint {
  readonly time: Rational;
  readonly value: Rational;
}

export interface TimeMap {
  readonly points: readonly TimePoint[];
  /** Constant speed: every segment has the same positive slope. */
  readonly linear: boolean;
}

function slope(left: TimePoint, right: TimePoint): Rational | null {
  const span = sub(right.time, left.time);
  return cmp(span, ZERO) > 0 ? div(sub(right.value, left.value), span) : null;
}

/** <timeMap> of an element: null when absent or empty, 'invalid' when unreadable. */
export function readTimeMap(element: XmlElement): TimeMap | null | 'invalid' {
  const container = firstChild(element, 'timeMap');
  if (!container) return null;
  const points: TimePoint[] = [];
  for (const point of childElements(container)) {
    if (point.tagName !== 'timept') continue;
    const time = parseTime(attr(point, 'time'));
    const value = parseTime(attr(point, 'value'));
    if (!time || !value) return 'invalid';
    points.push({ time, value });
  }
  if (!points.length) return null;
  const ordered = points.toSorted((left, right) => cmp(left.time, right.time));
  const slopes = ordered.slice(1).map((point, index) => slope(ordered[index]!, point));
  const first = slopes[0];
  const linear = slopes.every((value) => value !== null && first !== null && first !== undefined
    && cmp(value, first) === 0);
  return { points: ordered, linear };
}

/** Original clip time at adjusted time t: piecewise linear, extrapolated past the ends. */
export function evalTimeMap(map: TimeMap, time: Rational): Rational {
  const { points } = map;
  if (points.length === 1) return add(points[0]!.value, sub(time, points[0]!.time));
  let index = points.findIndex((point, position) => position > 0 && cmp(time, point.time) < 0);
  if (index < 0) index = points.length - 1;
  // Skip zero-length (jump) segments so a slope always exists.
  while (index > 1 && cmp(points[index]!.time, points[index - 1]!.time) === 0) index -= 1;
  const left = points[index - 1]!;
  const right = points[index]!;
  const segment = slope(left, right) ?? ONE;
  return add(left.value, mul(segment, sub(time, left.time)));
}

const CONFORM_RATES: Record<string, Rational> = {
  '23.98': rational(24000n, 1001n),
  '24': rational(24n),
  '25': rational(25n),
  '29.97': rational(30000n, 1001n),
  '30': rational(30n),
  '47.95': rational(48000n, 1001n),
  '48': rational(48n),
  '50': rational(50n),
  '59.94': rational(60000n, 1001n),
  '60': rational(60n),
};

/** Parent seconds per local second introduced by <conform-rate> (1 when absent or disabled). */
export function conformScale(element: XmlElement, timelineFps: Rational): Rational {
  const conform = firstChild(element, 'conform-rate');
  if (!conform || attr(conform, 'scaleEnabled') === '0') return ONE;
  const source = CONFORM_RATES[attr(conform, 'srcFrameRate')];
  return source ? div(source, timelineFps) : ONE;
}

export interface LocalMap {
  /** Original local time (the media clock for media elements) → parent time. */
  readonly map: Affine;
  /** A speed ramp was replaced by its average speed over the element. */
  readonly approximated: boolean;
}

/**
 * Original-local → parent map of an element. A time map is evaluated at the
 * element's start; a variable-speed map is approximated by the chord across the
 * element. Returns null for reverse or freeze-frame retimes.
 */
export function localToParent(
  offset: Rational,
  start: Rational,
  duration: Rational,
  conform: Rational,
  timeMap: TimeMap | null,
): LocalMap | null {
  if (!timeMap) return { map: shift(offset, start, conform), approximated: false };
  const origin = evalTimeMap(timeMap, start);
  const speed = timeMap.linear && timeMap.points.length > 1
    ? div(sub(timeMap.points[1]!.value, timeMap.points[0]!.value), sub(timeMap.points[1]!.time, timeMap.points[0]!.time))
    : timeMap.points.length === 1
      ? ONE
      : div(sub(evalTimeMap(timeMap, add(start, duration)), origin), duration);
  if (cmp(speed, ZERO) <= 0) return null;
  // Adjusted t = start + (u - origin) / speed lands at offset + (t - start).
  return {
    map: { a: sub(offset, div(origin, speed)), b: div(ONE, speed) },
    approximated: !timeMap.linear && timeMap.points.length > 1,
  };
}
