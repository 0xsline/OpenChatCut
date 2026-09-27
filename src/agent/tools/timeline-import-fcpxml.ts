// FCPXML → timeline clips. The walker places every media reference in sequence
// time; this module resolves each one against the media pool, measures its
// in-point from the file's own start, and converts to timeline frames.
import type { MediaAsset, TimelineState } from '../../editor/types';
import {
  ONE, ZERO, add, cmp, div, floorToInt, fromFrames, mul, parseTime, rateFromNumber, sub, toFrames, toNumber,
  type Rational,
} from './timeline-import-rational';
import { unapplyMap } from './timeline-import-fcpxml-timing';
import { walkSequence, type FcpxAsset, type FcpxLeaf, type FcpxResources, type WalkEnv } from './timeline-import-fcpxml-walk';
import {
  isStillAsset, isTimelineAsset, normalizedReference, resolveAsset, resolveSourceIn, sourceNoteLog, type SourceNoteLog,
} from './timeline-import-media';
import { dropFramesPerMinute, framesToLabel, hourStartFrames } from './timeline-import-timecode';
import { reconcileClips } from './timeline-import-layout';
import {
  describeSource, newReport,
  type ClipFamily, type ImportReport, type ParseResult, type ParsedClip, type UnresolvedReference,
} from './timeline-import-types';
import {
  attr, childElements, elements, firstChild,
  type XmlDocument, type XmlElement, type XmlParserConstructor,
} from './timeline-import-xml';

const WALK_BUDGET = 200_000;
const MIN_RATE = 0.1;
const MAX_RATE = 8;

/** Chrome and Safari keep the partial document and insert a <parsererror> into it. */
function parserErrorText(document: XmlDocument): string | undefined {
  const node = elements(document, 'parsererror')[0];
  if (!node) return undefined;
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^This page contains the following errors:\s*/i, '')
    .replace(/\s*Below is a rendering of the page up to the first error\.?$/i, '');
  return text.slice(0, 200) || 'parser error';
}

function parseXml(content: string, Parser: XmlParserConstructor): { document?: XmlDocument; error?: string } {
  const errors: string[] = [];
  try {
    const document = new Parser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(content, 'application/xml');
    const detail = errors[0] ?? parserErrorText(document);
    if (detail || document.documentElement?.tagName !== 'fcpxml') {
      return { error: `invalid FCPXML${detail ? `: ${detail}` : ''}` };
    }
    return { document };
  } catch (error) {
    return { error: `invalid FCPXML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function assetReferences(resource: XmlElement): string[] {
  // FCPXML <= 1.8 puts src on <asset>; 1.9+ uses <media-rep> children.
  const references = [attr(resource, 'id'), attr(resource, 'name'), attr(resource, 'src')];
  for (const mediaRep of elements(resource, 'media-rep')) {
    references.push(attr(mediaRep, 'src'), attr(mediaRep, 'suggestedFilename'));
  }
  for (const pathUrl of elements(resource, 'pathurl')) references.push(pathUrl.textContent?.trim() ?? '');
  return references.filter(Boolean);
}

/** The file an asset stands for, comparable across assets. */
function mediaFile(asset: XmlElement): string {
  const reps = elements(asset, 'media-rep');
  const original = reps.find((rep) => attr(rep, 'kind') === 'original-media') ?? reps[0];
  const src = attr(asset, 'src') || (original ? attr(original, 'src') : '');
  return src ? normalizedReference(src) : '';
}

/** Ids of assets that share a file but not a range: DaVinci Resolve writes one asset per clip. */
function rangeOnlyIds(assets: readonly XmlElement[]): Set<string> {
  const byFile = new Map<string, XmlElement[]>();
  for (const asset of assets) {
    const file = mediaFile(asset);
    if (!file) continue;
    const group = byFile.get(file);
    if (group) group.push(asset);
    else byFile.set(file, [asset]);
  }
  const time = (value: string) => {
    const parsed = parseTime(value);
    return parsed ? `${parsed.n}/${parsed.d}` : value;
  };
  const range = (asset: XmlElement) => `${time(attr(asset, 'start') || '0s')} ${time(attr(asset, 'duration'))}`;
  return new Set([...byFile.values()]
    .filter((group) => new Set(group.map(range)).size > 1)
    .flatMap((group) => group.map((asset) => attr(asset, 'id'))));
}

function readResources(document: XmlDocument): FcpxResources {
  const container = elements(document, 'resources')[0];
  const children = container ? childElements(container) : [];
  const formats = new Map(children.filter((child) => child.tagName === 'format').map((format) => [attr(format, 'id'), format]));
  const assetElements = children.filter((child) => child.tagName === 'asset');
  const ranged = rangeOnlyIds(assetElements);
  const assets = new Map<string, FcpxAsset>(assetElements.map((asset) => [
    attr(asset, 'id'),
    {
      id: attr(asset, 'id'),
      name: attr(asset, 'name'),
      start: parseTime(attr(asset, 'start')) ?? ZERO,
      duration: parseTime(attr(asset, 'duration')) ?? undefined,
      format: attr(asset, 'format') || undefined,
      references: assetReferences(asset),
      rangeOnly: ranged.has(attr(asset, 'id')),
    },
  ]));
  return {
    assets,
    media: new Map(children.filter((child) => child.tagName === 'media').map((media) => [attr(media, 'id'), media])),
    effects: new Set(children.filter((child) => child.tagName === 'effect').map((effect) => attr(effect, 'id'))),
    frameRate: (formatId) => {
      const format = formats.get(formatId);
      const frameDuration = format ? parseTime(attr(format, 'frameDuration')) : null;
      return frameDuration && frameDuration.n > 0n ? div(ONE, frameDuration) : null;
    },
  };
}

function chooseSequence(document: XmlDocument, report: ImportReport): { sequence: XmlElement; project?: XmlElement } | null {
  const projects = elements(document, 'project').filter((project) => firstChild(project, 'sequence'));
  if (projects.length > 1) {
    report.warnings.push(`the document has ${projects.length} projects; imported the first ("${attr(projects[0]!, 'name')}")`);
  }
  if (projects[0]) return { sequence: firstChild(projects[0], 'sequence')!, project: projects[0] };
  const sequence = elements(document, 'sequence')[0];
  return sequence ? { sequence } : null;
}

interface ClipContext {
  resources: FcpxResources;
  pool: readonly MediaAsset[];
  fps: Rational;
  projectFps: Rational;
  report: ImportReport;
  label: (seconds: Rational) => string;
  unresolved: Map<string, UnresolvedReference>;
  /** Pool matches by reference set: long timelines reuse a few hundred files. */
  matches: Map<string, MediaAsset | { reason: string }>;
  sourceNotes: SourceNoteLog;
}

function leafFamily(leaf: FcpxLeaf, asset: MediaAsset): ClipFamily {
  if (leaf.element === 'audio') return 'audio';
  if (leaf.element === 'video') return 'video';
  return asset.kind === 'audio' || leaf.srcEnable === 'audio' ? 'audio' : 'video';
}

/** HH:00:00:00 on the media clock at or before `seconds`. */
function clockHour(seconds: Rational, clockFps: Rational): Rational {
  const nominal = Math.max(1, Math.round(toNumber(clockFps)));
  return fromFrames(hourStartFrames(floorToInt(mul(seconds, clockFps)), nominal, false), clockFps);
}

function playbackRate(rate: Rational, still: boolean, notes: string[]): number | undefined {
  const value = toNumber(rate);
  if (still || Math.abs(value - 1) < 1e-9) return undefined;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, value));
  if (clamped !== value) notes.push(`speed ${Number(value.toFixed(3))}x clamped to ${clamped}x`);
  return clamped;
}

function leafToClip(leaf: FcpxLeaf, ctx: ClipContext): ParsedClip | null {
  const fcpAsset = ctx.resources.assets.get(leaf.ref)!;
  const references = [...new Set([leaf.ref, ...fcpAsset.references, leaf.name].filter(Boolean))];
  const skipLeaf = (reason: string, at: Rational) => {
    ctx.report.skipped.push({ element: leaf.element, name: leaf.name, at: ctx.label(at), reason });
    return null;
  };
  const reference = references.join(' | ');
  const resolved = ctx.matches.get(reference) ?? resolveAsset(ctx.pool, references);
  ctx.matches.set(reference, resolved);
  if ('reason' in resolved) {
    ctx.unresolved.set(reference, { reference, reason: resolved.reason });
    return null;
  }
  const asset = resolved;
  let start = leaf.window.start;
  const end = leaf.window.end;
  if (!isTimelineAsset(asset)) return skipLeaf(`${asset.name} is not timeline media`, start);
  const family = leafFamily(leaf, asset);
  if (asset.kind === 'audio' && (family === 'video' || leaf.srcEnable === 'video')) {
    return skipLeaf(`video component references audio-only ${asset.name}`, start);
  }
  if (family === 'audio' && asset.kind !== 'audio' && asset.kind !== 'video') {
    return skipLeaf(`audio component references ${asset.kind} ${asset.name}`, start);
  }
  if (cmp(end, ZERO) <= 0) return skipLeaf('lies entirely before the sequence start', start);
  const notes = [...leaf.notes];
  if (cmp(start, ZERO) < 0) {
    notes.push('trimmed at the sequence start');
    start = ZERO;
  }
  const rate = div(ONE, leaf.media.b);
  const mediaIn = unapplyMap(leaf.media, start);
  const clockFps = (fcpAsset.format && ctx.resources.frameRate(fcpAsset.format)) || ctx.fps;
  const source = resolveSourceIn({
    mediaIn,
    length: mul(sub(end, start), rate),
    declaredStart: fcpAsset.start,
    declaredDuration: fcpAsset.duration,
    rangeOnly: fcpAsset.rangeOnly,
    hourStart: clockHour(mediaIn, clockFps),
    asset,
    projectFps: ctx.projectFps,
  });
  if (!source.ok) return skipLeaf(source.reason, start);
  if (source.note) ctx.sourceNotes.add(source.note, asset.name);
  let inPoint = source.in;
  if (cmp(inPoint, ZERO) < 0) {
    // The clip begins before its media's first frame: start the clip where the media does.
    start = add(start, div(sub(ZERO, inPoint), rate));
    inPoint = ZERO;
    notes.push('starts before its media and was trimmed to the first media frame');
    if (cmp(start, end) >= 0) return skipLeaf('lies entirely before its media', leaf.window.start);
  }
  const startFrame = toFrames(start, ctx.fps);
  const durationInFrames = toFrames(end, ctx.fps) - startFrame;
  if (durationInFrames <= 0) return skipLeaf('shorter than one frame', start);
  const still = isStillAsset(asset);
  const from = { element: leaf.element, name: leaf.name, at: ctx.label(start) };
  const speed = playbackRate(rate, still, notes);
  for (const note of notes) ctx.report.warnings.push(`${describeSource(from)}: ${note}`);
  return {
    name: leaf.name || asset.name,
    assetId: asset.id,
    family,
    lane: leaf.lane,
    startFrame,
    durationInFrames,
    sourceStartFrame: still ? 0 : toFrames(inPoint, ctx.fps),
    ...(speed !== undefined ? { playbackRate: speed } : {}),
    ...(family === 'video' && asset.kind === 'video' && leaf.srcEnable === 'video' ? { muted: true } : {}),
    ...(family === 'audio' && asset.kind === 'video' ? { audioOfVideo: true } : {}),
    from,
  };
}

export function parseFcpxml(
  content: string,
  pool: readonly MediaAsset[],
  fallback: TimelineState,
  Parser: XmlParserConstructor,
): ParseResult {
  if (/<!ENTITY/i.test(content)) return { ok: false, error: 'FCPXML entity declarations are rejected' };
  const parsedXml = parseXml(content, Parser);
  if (!parsedXml.document) return { ok: false, error: parsedXml.error ?? 'invalid FCPXML' };
  const report = newReport();
  const chosen = chooseSequence(parsedXml.document, report);
  if (!chosen) return { ok: false, error: 'FCPXML has no sequence' };
  const { sequence, project } = chosen;
  const resources = readResources(parsedXml.document);
  const format = elements(parsedXml.document, 'format').find((candidate) => attr(candidate, 'id') === attr(sequence, 'format'));
  const projectFps = rateFromNumber(fallback.fps);
  const fps = resources.frameRate(attr(sequence, 'format')) ?? projectFps;
  const tcStart = parseTime(attr(sequence, 'tcStart') || '0s');
  if (!tcStart) return { ok: false, error: `invalid FCPXML sequence tcStart "${attr(sequence, 'tcStart')}"` };
  const nominal = Math.max(1, Math.round(toNumber(fps)));
  const dropFrame = attr(sequence, 'tcFormat') === 'DF' && dropFramesPerMinute(nominal) !== null;
  const label = (seconds: Rational) => framesToLabel(toFrames(add(tcStart, seconds), fps), nominal, dropFrame);
  const env: WalkEnv = { resources, report, leaves: [], label, counters: { hidden: 0, budget: WALK_BUDGET } };
  walkSequence(sequence, tcStart, fps, env);
  if (env.counters.budget < 0) report.warnings.push(`stopped after ${WALK_BUDGET} story elements; the rest was not imported`);
  if (env.counters.hidden) {
    report.warnings.push(`${env.counters.hidden} clip(s) outside their compound, sync or parent clip's visible range were omitted, as in the source NLE`);
  }
  const unresolved = new Map<string, UnresolvedReference>();
  const context: ClipContext = {
    resources, pool, fps, projectFps, report, label, unresolved, matches: new Map(), sourceNotes: sourceNoteLog(),
  };
  const clips = env.leaves.map((leaf) => leafToClip(leaf, context)).filter((clip): clip is ParsedClip => !!clip);
  report.warnings.push(...context.sourceNotes.warnings());
  if (unresolved.size) {
    return { ok: false, error: 'FCPXML media references are unresolved', unresolved: [...unresolved.values()] };
  }
  const reconciled = reconcileClips(clips, report);
  if (!reconciled.length) {
    return { ok: false, error: 'FCPXML sequence has no importable clips', skipped: report.skipped };
  }
  return {
    ok: true,
    timeline: {
      name: attr(project ?? sequence, 'name') || 'Imported FCPXML',
      fps: toNumber(fps),
      width: Number(attr(format ?? sequence, 'width')) || fallback.width,
      height: Number(attr(format ?? sequence, 'height')) || fallback.height,
      clips: reconciled,
      warnings: report.warnings,
      skipped: report.skipped,
      startTimecode: label(ZERO),
    },
  };
}
