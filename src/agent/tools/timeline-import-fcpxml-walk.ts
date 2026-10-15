// FCPXML story walker: flattens a sequence's nested story elements into media
// leaves placed in sequence time (seconds from the sequence's tcStart).
//
// Containment follows Apple's FCPXML reference: items with lane 0 are
// contained in their parent and cannot outlast it; items with a non-zero lane
// are anchored (connected clips, connected storylines) and are not limited by
// their parent, only by whatever contains that parent (a compound, sync or
// multicam clip). DaVinci Resolve relies on this: it anchors whole audio tracks
// to a one-frame gap at the head of the spine.
import { ONE, ZERO, add, cmp, mul, neg, parseTime, type Rational } from './timeline-import-rational';
import {
  applyMap, compose, conformScale, intersect, localToParent, readTimeMap, shift,
  type Affine, type Window,
} from './timeline-import-fcpxml-timing';
import { attr, childElements, firstChild, hasAttr, type XmlElement } from './timeline-import-xml';
import type { ImportReport } from './timeline-import-types';

export type SrcEnable = 'all' | 'video' | 'audio' | 'none';

export interface FcpxAsset {
  id: string;
  name: string;
  /** asset@start: where the file's own clock begins (default 0s). */
  start: Rational;
  duration?: Rational;
  format?: string;
  references: string[];
  /** Other assets describe other ranges of the same file (DaVinci Resolve per-clip assets). */
  rangeOnly: boolean;
}

export interface FcpxResources {
  assets: ReadonlyMap<string, FcpxAsset>;
  media: ReadonlyMap<string, XmlElement>;
  effects: ReadonlySet<string>;
  frameRate: (formatId: string) => Rational | null;
}

/** A media reference (asset-clip / video / audio) with its visible range. */
export interface FcpxLeaf {
  element: 'asset-clip' | 'video' | 'audio';
  ref: string;
  name: string;
  lane: number;
  srcEnable: SrcEnable;
  /** Visible range in sequence seconds. */
  window: Window;
  /** Media clock seconds → sequence seconds. */
  media: Affine;
  notes: string[];
}

interface WalkContext {
  /** Local time of the current container's children → sequence seconds. */
  map: Affine;
  /** Range the children may occupy (null: unlimited). */
  limit: Window | null;
  lane: number;
  srcEnable: SrcEnable;
  /** Frame rate of the enclosing sequence or multicam, for rate conform. */
  timelineFps: Rational;
  /** Compound/multicam media being expanded (cycle guard). */
  expanding: readonly string[];
}

export interface WalkEnv {
  resources: FcpxResources;
  report: ImportReport;
  leaves: FcpxLeaf[];
  /** Sequence seconds → the NLE's timecode label, for reports. */
  label: (sequenceSeconds: Rational) => string;
  counters: { hidden: number; budget: number };
}

interface Timing {
  offset: Rational;
  start: Rational;
  duration: Rational;
}

interface ElementMaps {
  /** Original local time (the media clock for media elements) → parent time. */
  media: Affine;
  /** Adjusted (retimed) local time → parent time, for anchored children. */
  anchored: Affine;
  approximated: boolean;
}

const STORY = new Set([
  'spine', 'gap', 'transition', 'title', 'caption', 'asset-clip', 'video', 'audio',
  'clip', 'sync-clip', 'ref-clip', 'mc-clip', 'audition',
]);
const MAX_NESTING = 16;

function laneOf(element: XmlElement): number {
  const lane = Number.parseInt(attr(element, 'lane'), 10);
  return Number.isFinite(lane) ? lane : 0;
}

function combineSrcEnable(outer: SrcEnable, own: string): SrcEnable {
  const inner: SrcEnable = own === 'audio' || own === 'video' ? own : 'all';
  if (outer === 'all') return inner;
  return inner === 'all' || inner === outer ? outer : 'none';
}

/** undefined when absent, null when present but unreadable. */
function timeAttr(element: XmlElement, name: string): Rational | null | undefined {
  return hasAttr(element, name) ? parseTime(attr(element, name)) : undefined;
}

function skip(env: WalkEnv, element: XmlElement, reason: string, at?: Rational): void {
  const name = attr(element, 'name');
  env.report.skipped.push({
    element: element.tagName,
    ...(name ? { name } : {}),
    ...(at ? { at: env.label(at) } : {}),
    reason,
  });
}

function warn(env: WalkEnv, element: XmlElement, at: Rational, message: string): void {
  const name = attr(element, 'name');
  env.report.warnings.push(`${element.tagName}${name ? ` "${name}"` : ''} at ${env.label(at)}: ${message}`);
}

/** Clock origin and length of the media an element references, for default start/duration. */
function sourceOf(element: XmlElement, env: WalkEnv): { start: Rational; duration?: Rational } | undefined {
  const ref = attr(element, 'ref');
  const asset = env.resources.assets.get(ref);
  if (asset) return { start: asset.start, duration: asset.duration };
  const media = env.resources.media.get(ref);
  const timeline = media && (firstChild(media, 'sequence') ?? firstChild(media, 'multicam'));
  if (!timeline) return undefined;
  return { start: parseTime(attr(timeline, 'tcStart')) ?? ZERO, duration: parseTime(attr(timeline, 'duration')) ?? undefined };
}

function readTiming(element: XmlElement, ctx: WalkContext, env: WalkEnv, offsetOverride?: Rational): Timing | null {
  const offset = timeAttr(element, 'offset');
  const start = timeAttr(element, 'start');
  const duration = timeAttr(element, 'duration');
  if (offset === null || start === null || duration === null) {
    skip(env, element, 'unreadable time attribute');
    return null;
  }
  const source = sourceOf(element, env);
  const resolvedStart = start ?? source?.start ?? ZERO;
  // asset-clip may omit duration: it then runs to the end of its media.
  const remaining = source?.duration && !firstChild(element, 'timeMap')
    ? add(source.start, add(source.duration, neg(resolvedStart)))
    : undefined;
  const resolvedDuration = duration ?? (remaining ? mul(conformScale(element, ctx.timelineFps), remaining) : undefined);
  const resolvedOffset = offset ?? offsetOverride ?? ZERO;
  if (!resolvedDuration || resolvedDuration.n <= 0n) {
    skip(env, element, 'missing or non-positive duration', applyMap(ctx.map, resolvedOffset));
    return null;
  }
  return { offset: resolvedOffset, start: resolvedStart, duration: resolvedDuration };
}

function elementMaps(element: XmlElement, timing: Timing, ctx: WalkContext, env: WalkEnv, at: Rational): ElementMaps | null {
  const timeMap = readTimeMap(element);
  if (timeMap === 'invalid') {
    skip(env, element, 'unreadable timeMap', at);
    return null;
  }
  const conform = conformScale(element, ctx.timelineFps);
  const local = localToParent(timing.offset, timing.start, timing.duration, conform, timeMap);
  if (!local) {
    skip(env, element, 'reverse and freeze-frame retimes are not supported', at);
    return null;
  }
  const anchored = timeMap ? shift(timing.offset, timing.start) : shift(timing.offset, timing.start, conform);
  return { media: local.map, anchored, approximated: local.approximated };
}

function visitAnchored(element: XmlElement, local: Affine, ctx: WalkContext, env: WalkEnv): void {
  const anchoredCtx = { ...ctx, map: compose(ctx.map, local) };
  for (const child of childElements(element)) {
    if (laneOf(child) !== 0) visitStory(child, anchoredCtx, env);
  }
}

function visitSpine(element: XmlElement, ctx: WalkContext, env: WalkEnv, lane: number): void {
  const offset = timeAttr(element, 'offset');
  if (offset === null) {
    skip(env, element, 'unreadable time attribute');
    return;
  }
  const spineCtx = { ...ctx, map: compose(ctx.map, shift(offset ?? ZERO, ZERO)), lane };
  for (const child of childElements(element)) visitStory(child, spineCtx, env);
}

function visitAudition(element: XmlElement, ctx: WalkContext, env: WalkEnv, lane: number): void {
  // The active pick is exported first; the alternatives are not on the timeline.
  const pick = childElements(element).find((child) => STORY.has(child.tagName));
  const offset = timeAttr(element, 'offset');
  if (offset === null) {
    skip(env, element, 'unreadable time attribute');
    return;
  }
  if (pick) visitStory(pick, { ...ctx, lane }, env, offset ?? ZERO);
}

const SPLIT_EDIT_NOTE = 'split-edit audio (audioStart/audioDuration) follows the video timing';

/** audioStart/audioDuration that differ from start/duration (DaVinci Resolve writes them equal on every clip). */
function isSplitEdit(element: XmlElement, timing: Timing): boolean {
  const audioStart = timeAttr(element, 'audioStart');
  const audioDuration = timeAttr(element, 'audioDuration');
  return (!!audioStart && cmp(audioStart, timing.start) !== 0)
    || (!!audioDuration && cmp(audioDuration, timing.duration) !== 0);
}

function visitMedia(element: XmlElement, timing: Timing, visible: Window | null, ctx: WalkContext, env: WalkEnv, at: Rational): void {
  const tag = element.tagName as FcpxLeaf['element'];
  const ref = attr(element, 'ref');
  const maps = elementMaps(element, timing, ctx, env, at);
  if (!maps) return;
  const srcEnable = combineSrcEnable(ctx.srcEnable, attr(element, 'srcEnable'));
  const excluded = srcEnable === 'none' || (tag === 'video' && srcEnable === 'audio')
    || (tag === 'audio' && srcEnable === 'video');
  if (env.resources.effects.has(ref)) {
    skip(env, element, tag === 'video' ? 'generators are not imported' : 'effect audio is not imported', at);
  } else if (!env.resources.assets.has(ref)) {
    skip(env, element, `references unknown resource "${ref}"`, at);
  } else if (attr(element, 'enabled') === '0') {
    skip(env, element, 'disabled clip', at);
  } else if (!excluded) {
    if (!visible) {
      env.counters.hidden += 1;
    } else {
      const notes = [
        ...(maps.approximated ? ['speed ramp approximated by its average speed'] : []),
        ...(isSplitEdit(element, timing) ? [SPLIT_EDIT_NOTE] : []),
      ];
      env.leaves.push({
        element: tag,
        ref,
        name: attr(element, 'name') || env.resources.assets.get(ref)!.name,
        lane: ctx.lane,
        srcEnable,
        window: visible,
        media: compose(ctx.map, maps.media),
        notes,
      });
    }
  }
  visitAnchored(element, maps.anchored, ctx, env);
}

function containerNotes(element: XmlElement, timing: Timing, maps: ElementMaps, env: WalkEnv, at: Rational): void {
  if (maps.approximated) warn(env, element, at, 'speed ramp approximated by its average speed');
  if (isSplitEdit(element, timing)) warn(env, element, at, SPLIT_EDIT_NOTE);
}

function visitContainer(element: XmlElement, timing: Timing, visible: Window | null, ctx: WalkContext, env: WalkEnv, at: Rational): void {
  const maps = elementMaps(element, timing, ctx, env, at);
  if (!maps) return;
  if (attr(element, 'enabled') === '0') {
    skip(env, element, 'disabled clip', at);
    visitAnchored(element, maps.anchored, ctx, env);
    return;
  }
  containerNotes(element, timing, maps, env, at);
  const containedCtx = { ...ctx, map: compose(ctx.map, maps.media), limit: visible ?? { start: at, end: at } };
  const anchoredCtx = { ...ctx, map: compose(ctx.map, maps.anchored) };
  for (const child of childElements(element)) {
    visitStory(child, laneOf(child) === 0 ? containedCtx : anchoredCtx, env);
  }
}

/** ref-clip (compound clip) and mc-clip (multicam): expand the referenced media inside the clip's window. */
function visitReference(element: XmlElement, timing: Timing, visible: Window | null, ctx: WalkContext, env: WalkEnv, at: Rational): void {
  const ref = attr(element, 'ref');
  const multicam = element.tagName === 'mc-clip';
  const media = env.resources.media.get(ref);
  const timeline = media ? firstChild(media, multicam ? 'multicam' : 'sequence') : undefined;
  const maps = elementMaps(element, timing, ctx, env, at);
  if (!maps) return;
  const srcEnable = combineSrcEnable(ctx.srcEnable, attr(element, 'srcEnable'));
  if (!timeline) {
    skip(env, element, `${multicam ? 'multicam' : 'compound clip'} media "${ref}" not found`, at);
  } else if (ctx.expanding.includes(ref) || ctx.expanding.length >= MAX_NESTING) {
    skip(env, element, 'recursive or too deeply nested compound clip', at);
  } else if (attr(element, 'enabled') === '0') {
    skip(env, element, 'disabled clip', at);
  } else {
    containerNotes(element, timing, maps, env, at);
    const inner: WalkContext = {
      map: compose(ctx.map, maps.media),
      limit: visible ?? { start: at, end: at },
      lane: ctx.lane,
      srcEnable,
      timelineFps: env.resources.frameRate(attr(timeline, 'format')) ?? ctx.timelineFps,
      expanding: [...ctx.expanding, ref],
    };
    if (!multicam) {
      const spine = firstChild(timeline, 'spine');
      if (spine) visitSpine(spine, inner, env, ctx.lane);
    } else {
      visitAngles(element, timeline, inner, env, at);
    }
  }
  visitAnchored(element, maps.anchored, ctx, env);
}

function visitAngles(clip: XmlElement, multicam: XmlElement, inner: WalkContext, env: WalkEnv, at: Rational): void {
  const angles = new Map(childElements(multicam)
    .filter((angle) => angle.tagName === 'mc-angle')
    .map((angle) => [attr(angle, 'angleID'), angle]));
  const sources = childElements(clip)
    .filter((source) => source.tagName === 'mc-source' && attr(source, 'srcEnable') !== 'none');
  if (!sources.length) skip(env, clip, 'multicam clip has no active angle', at);
  for (const source of sources) {
    const angle = angles.get(attr(source, 'angleID'));
    if (!angle) {
      skip(env, clip, `multicam angle "${attr(source, 'angleID')}" not found`, at);
      continue;
    }
    // An angle is a storyline in the multicam's timeline, like a spine.
    visitSpine(angle, { ...inner, srcEnable: combineSrcEnable(inner.srcEnable, attr(source, 'srcEnable')) }, env, inner.lane);
  }
}

function visitStory(element: XmlElement, ctx: WalkContext, env: WalkEnv, offsetOverride?: Rational): void {
  env.counters.budget -= 1;
  if (env.counters.budget < 0) return;
  const tag = element.tagName;
  if (!STORY.has(tag)) {
    // Markers, keywords, filters, adjustments and metadata carry no media.
    if (hasAttr(element, 'offset') && hasAttr(element, 'duration')) skip(env, element, `<${tag}> is not supported`);
    return;
  }
  const lane = ctx.lane + laneOf(element);
  if (tag === 'spine') return visitSpine(element, ctx, env, lane);
  if (tag === 'audition') return visitAudition(element, ctx, env, lane);
  const timing = readTiming(element, ctx, env, offsetOverride);
  if (!timing) return;
  const at = applyMap(ctx.map, timing.offset);
  const visible = intersect({ start: at, end: applyMap(ctx.map, add(timing.offset, timing.duration)) }, ctx.limit);
  const scoped = { ...ctx, lane };
  switch (tag) {
    case 'transition':
      skip(env, element, 'transitions are not imported; the clips meet with a cut', at);
      return;
    case 'gap':
      // Gaps cannot be anchored in FCPXML; OpenChatCut exports use them as motion-graphic placeholders.
      if (laneOf(element) !== 0) skip(env, element, 'placeholder gap has no media', at);
      return visitAnchored(element, shift(timing.offset, timing.start), scoped, env);
    case 'title':
    case 'caption':
      skip(env, element, `${tag}s are not imported`, at);
      return visitAnchored(element, shift(timing.offset, timing.start), scoped, env);
    case 'clip':
    case 'sync-clip':
      return visitContainer(element, timing, visible, scoped, env, at);
    case 'ref-clip':
    case 'mc-clip':
      return visitReference(element, timing, visible, scoped, env, at);
    default:
      return visitMedia(element, timing, visible, scoped, env, at);
  }
}

/** Walk a project sequence; leaf windows are measured from its tcStart. */
export function walkSequence(sequence: XmlElement, tcStart: Rational, fps: Rational, env: WalkEnv): void {
  const spine = firstChild(sequence, 'spine');
  if (!spine) return;
  const root: WalkContext = {
    map: { a: neg(tcStart), b: ONE },
    limit: null,
    lane: 0,
    srcEnable: 'all',
    timelineFps: fps,
    expanding: [],
  };
  visitSpine(spine, root, env, 0);
}
