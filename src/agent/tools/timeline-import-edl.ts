// CMX 3600 EDL → timeline clips.
//
// Record timecodes are positions on the NLE's program clock, which DaVinci
// Resolve and Avid start at 01:00:00:00 by default, so events are placed
// relative to the list's record start: the hour boundary when the earliest
// record-in lies within a minute of it (keeping a short head of black), the
// earliest record-in otherwise (OpenTimelineIO's cmx_3600 adapter likewise
// starts each track at its first record-in), or an explicit startTimecode.
// Source timecodes are positions on each file's own clock (see
// timeline-import-media.ts). Drop-frame comes from a ';' label or the
// "FCM: DROP FRAME" statement that governs the events after it (CMX 3600 spec).
import type { MediaAsset, TimelineState } from '../../editor/types';
import { fromFrames, rateFromNumber, rational, toFrames, toNumber, type Rational } from './timeline-import-rational';
import {
  isTimelineAsset, resolveAsset, resolveSourceIn, sourceNoteLog, type SourceNoteLog,
} from './timeline-import-media';
import {
  dropFramesPerMinute, framesToLabel, hourStartFrames, labelToFrames, parseTimecodeLabel,
} from './timeline-import-timecode';
import { reconcileClips } from './timeline-import-layout';
import {
  describeSource, newReport,
  type ImportReport, type ParseResult, type ParsedClip, type TimelineImportOptions, type UnresolvedReference,
} from './timeline-import-types';

interface EdlLine {
  number: string;
  reel: string;
  channels: string;
  transition: string;
  times: [string, string, string, string];
  /** FCM mode in effect for this line's sources. */
  sourceDrop: boolean;
}

interface EdlEvent {
  lines: EdlLine[];
  fromName?: string;
  toName?: string;
  fromFile?: string;
  toFile?: string;
  /** M2 motion effect speed in frames per second. */
  speed?: number;
  split?: boolean;
}

interface Scan {
  title?: string;
  headerDrop: boolean;
  events: EdlEvent[];
  unreadable: string[];
}

const TIME_TOKEN = /^(?:\d{1,2}[:;]\d{2}[:;]\d{2}[:;.,]\d{2}|\d+)$/;
const TRANSITION = /^(?:C|D|W\d{3}|K|KB|KO)$/i;
const BLACK_REELS = new Set(['BL', 'BLK', 'BLACK']);
const LEAD_IN_SECONDS = 60;
const MIN_RATE = 0.1;
const MAX_RATE = 8;

function commentInto(event: EdlEvent | undefined, line: string): void {
  if (!event) return;
  const text = line.replace(/^\*\s*/, '');
  const value = (pattern: RegExp) => pattern.exec(text)?.[1]?.trim();
  const fromName = value(/^FROM CLIP NAME\s*:\s*(.+)$/i);
  const toName = value(/^TO CLIP NAME\s*:\s*(.+)$/i);
  const fromFile = value(/^(?:FROM CLIP|FROM FILE|SOURCE FILE)\s*:\s*(.+)$/i);
  const toFile = value(/^(?:TO CLIP|TO FILE)\s*:\s*(.+)$/i);
  const speed = /^M2\s+.*?\s(-?\d+(?:\.\d+)?)\s+\S+\s*$/i.exec(text)?.[1];
  if (fromName) event.fromName = fromName;
  else if (toName) event.toName = toName;
  else if (fromFile) event.fromFile = fromFile;
  else if (toFile) event.toFile = toFile;
  else if (speed !== undefined) event.speed = Number(speed);
  else if (/^SPLIT\s*:/i.test(text)) event.split = true;
}

function scan(content: string): Scan {
  const result: Scan = { headerDrop: false, events: [], unreadable: [] };
  let currentDrop = false;
  let current: EdlEvent | undefined;
  for (const raw of content.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^TITLE\s*:/i.test(line)) {
      result.title ??= line.replace(/^TITLE\s*:\s*/i, '').trim();
    } else if (/^FCM\s*:/i.test(line)) {
      currentDrop = /DROP/i.test(line) && !/NON[\s-]*DROP/i.test(line);
      if (!result.events.length) result.headerDrop = currentDrop;
    } else if (/^\d{1,6}\s/.test(line)) {
      const tokens = line.split(/\s+/);
      const times = tokens.slice(-4);
      const fields = tokens.slice(1, -4);
      if (tokens.length < 8 || tokens.length > 9 || !times.every((time) => TIME_TOKEN.test(time))
        || !TRANSITION.test(fields[2] ?? '')) {
        result.unreadable.push(line);
        continue;
      }
      const parsed: EdlLine = {
        number: tokens[0]!,
        reel: fields[0]!,
        channels: fields[1]!.toUpperCase(),
        transition: fields[2]!.toUpperCase(),
        times: times as EdlLine['times'],
        sourceDrop: currentDrop,
      };
      if (current && current.lines.length === 1 && Number(current.lines[0]!.number) === Number(parsed.number)) {
        current.lines.push(parsed);
      } else {
        current = { lines: [parsed] };
        result.events.push(current);
      }
    } else {
      commentInto(current, line);
    }
  }
  return result;
}

interface Channels {
  video: number | null;
  audio: number[];
}

/** CMX 3600 channel field: A, B (A1+V), V, A2, A2/V, AA, AA/V, plus An/Vn used by newer tools. */
function channelsOf(code: string): Channels | null {
  const channels: Channels = { video: null, audio: [] };
  for (const part of code.split('/')) {
    if (part === 'V') channels.video = 1;
    else if (part === 'B') [channels.video, channels.audio] = [1, [...channels.audio, 1]];
    else if (part === 'A') channels.audio.push(1);
    else if (part === 'AA') channels.audio.push(1, 2);
    else if (/^A\d+$/.test(part)) channels.audio.push(Number(part.slice(1)));
    else if (/^V\d+$/.test(part)) channels.video = Number(part.slice(1));
    else if (part !== 'NONE') return null;
  }
  return channels;
}

interface Clock {
  fps: Rational;
  nominal: number;
  /** Physical frame count of a timecode token, or null when it cannot exist at this rate. */
  frames: (token: string, drop: boolean) => number | null;
  label: (frames: number) => string;
}

function clockFor(scanned: Scan, fallbackFps: number, options: TimelineImportOptions): Clock | string {
  const requested = options.fps ?? fallbackFps;
  if (!(requested > 0)) return 'fps must be a positive number';
  const tokens = scanned.events.flatMap((event) => event.lines.flatMap((line) => line.times));
  const dropFrame = scanned.headerDrop || tokens.some((token) => token.includes(';'));
  const nominal = Math.round(requested);
  if (dropFrame && dropFramesPerMinute(nominal) === null) {
    return `drop-frame timecode requires 29.97 or 59.94 fps, not ${requested}`;
  }
  // Drop-frame timecode only exists at the NTSC rates.
  const fps = dropFrame ? rational(BigInt(nominal * 1000), 1001n) : rateFromNumber(requested);
  return {
    fps,
    nominal,
    frames: (token, drop) => {
      if (/^\d+$/.test(token)) return Number(token);
      const label = parseTimecodeLabel(token);
      return label ? labelToFrames(label, nominal, drop || label.dropFrame) : null;
    },
    label: (frames) => framesToLabel(frames, nominal, scanned.headerDrop),
  };
}

function recordOrigin(scanned: Scan, clock: Clock, options: TimelineImportOptions): number | string {
  if (options.startTimecode !== undefined) {
    const frames = clock.frames(options.startTimecode.trim(), scanned.headerDrop);
    return frames ?? `invalid startTimecode "${options.startTimecode}"`;
  }
  const recordIns = scanned.events.flatMap((event) => event.lines)
    .map((line) => clock.frames(line.times[2], scanned.headerDrop))
    .filter((frames): frames is number => frames !== null);
  if (!recordIns.length) return 0;
  const earliest = Math.min(...recordIns);
  const hour = hourStartFrames(earliest, clock.nominal, scanned.headerDrop);
  return earliest - hour <= LEAD_IN_SECONDS * clock.nominal ? hour : earliest;
}

interface EventContext {
  pool: readonly MediaAsset[];
  clock: Clock;
  origin: number;
  recordDrop: boolean;
  projectFps: Rational;
  report: ImportReport;
  unresolved: Map<string, UnresolvedReference>;
  matches: Map<string, MediaAsset | { reason: string }>;
  sourceNotes: SourceNoteLog;
}

function lineToClips(event: EdlEvent, index: number, ctx: EventContext): ParsedClip[] {
  const line = event.lines[index]!;
  const incoming = index === 1;
  const { clock, report } = ctx;
  // A fade from black names its only clip with FROM CLIP NAME when it has no TO CLIP NAME.
  const fromBlack = incoming && BLACK_REELS.has(event.lines[0]!.reel.toUpperCase());
  const name = (incoming ? event.toName ?? (fromBlack ? event.fromName : undefined) : event.fromName) ?? line.reel;
  // The header FCM governs the record clock; later FCM statements announce sources.
  const [sourceIn, sourceOut, recordIn, recordOut] = line.times.map((token, position) => (
    clock.frames(token, position < 2 ? line.sourceDrop : ctx.recordDrop)
  ));
  const at = recordIn === null ? line.times[2] : clock.label(recordIn);
  const skip = (reason: string): ParsedClip[] => {
    report.skipped.push({ element: `event ${line.number}`, name, at, reason });
    return [];
  };
  if (sourceIn === null || sourceOut === null || recordIn === null || recordOut === null) {
    return skip(`timecode does not exist at ${Number(toNumber(clock.fps).toFixed(3))} fps; pass the list's frame rate as fps`);
  }
  if (incoming && line.transition !== 'C') {
    report.skipped.push({ element: `event ${line.number}`, name, at, reason: `${line.transition.startsWith('W') ? 'wipe' : line.transition === 'D' ? 'dissolve' : 'key'} transition is not imported; the clips meet with a cut` });
  }
  if (BLACK_REELS.has(line.reel.toUpperCase()) || recordOut === recordIn) return [];
  if (line.reel.toUpperCase() === 'BARS') return skip('bars are not imported');
  if (recordOut < recordIn) return skip('record out precedes record in');
  const channels = channelsOf(line.channels);
  if (!channels) return skip(`unknown channel "${line.channels}"`);
  if (event.speed !== undefined && event.speed <= 0) {
    return skip(event.speed === 0 ? 'freeze frames are not imported' : 'reverse motion is not imported');
  }
  const rate = event.speed !== undefined ? event.speed / clock.nominal : 1;
  const file = incoming ? event.toFile ?? (fromBlack ? event.fromFile : undefined) : event.fromFile;
  const references = [...new Set([line.reel.toUpperCase() === 'AX' ? '' : line.reel, file ?? '', name])].filter(Boolean);
  const key = references.join(' | ');
  const resolved = ctx.matches.get(key) ?? resolveAsset(ctx.pool, references);
  ctx.matches.set(key, resolved);
  if ('reason' in resolved) {
    if (!ctx.unresolved.has(key)) ctx.unresolved.set(key, { reference: `event ${line.number}: ${key || line.reel}`, reason: resolved.reason });
    return [];
  }
  const asset = resolved;
  if (!isTimelineAsset(asset)) return skip(`${asset.name} is not timeline media`);
  let start = recordIn - ctx.origin;
  let duration = recordOut - recordIn;
  let source = sourceIn;
  if (start < 0) {
    if (start + duration <= 0) return skip('lies before the start timecode');
    source += Math.round(-start * rate);
    duration += start;
    start = 0;
  }
  // Record frames land on the project's frames, whatever rate the list was written at.
  const onProject = (frames: number) => toFrames(fromFrames(frames, clock.fps), ctx.projectFps);
  const startFrame = onProject(start);
  const durationInFrames = onProject(start + duration) - startFrame;
  if (durationInFrames <= 0) return skip('shorter than one frame');
  if (event.speed === undefined && sourceOut - sourceIn !== recordOut - recordIn) {
    report.warnings.push(`event ${line.number} "${name}" at ${at}: source and record durations differ; the record duration was used`);
  }
  const resolvedIn = resolveSourceIn({
    mediaIn: fromFrames(source, clock.fps),
    length: fromFrames(duration * rate, clock.fps),
    hourStart: fromFrames(hourStartFrames(source, clock.nominal, line.sourceDrop), clock.fps),
    asset,
    projectFps: ctx.projectFps,
  });
  if (!resolvedIn.ok) return skip(resolvedIn.reason);
  const from = { element: `event ${line.number}`, name, at };
  if (resolvedIn.note) ctx.sourceNotes.add(resolvedIn.note, asset.name);
  const clampedRate = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  if (clampedRate !== rate) report.warnings.push(`${describeSource(from)}: speed ${Number(rate.toFixed(3))}x clamped to ${clampedRate}x`);
  const base = {
    name,
    assetId: asset.id,
    startFrame,
    durationInFrames,
    sourceStartFrame: Math.max(0, toFrames(resolvedIn.in, ctx.projectFps)),
    ...(clampedRate !== 1 ? { playbackRate: clampedRate } : {}),
    from,
  };
  const clips: ParsedClip[] = [];
  const videoUsable = channels.video !== null && asset.kind !== 'audio';
  if (channels.video !== null && !videoUsable) skip(`video channel references audio-only ${asset.name}`);
  if (videoUsable) clips.push({ ...base, family: 'video', lane: channels.video! });
  if (channels.audio.length && !videoUsable) {
    if (asset.kind === 'audio' || asset.kind === 'video') {
      clips.push({
        ...base,
        family: 'audio',
        lane: -Math.min(...channels.audio),
        ...(asset.kind === 'video' ? { audioOfVideo: true } : {}),
      });
    } else {
      skip(`audio channel references ${asset.kind} ${asset.name}`);
    }
  }
  return clips;
}

export function parseEdl(
  content: string,
  pool: readonly MediaAsset[],
  fallback: TimelineState,
  options: TimelineImportOptions = {},
): ParseResult {
  const scanned = scan(content);
  if (!scanned.events.length) return { ok: false, error: 'EDL has no CMX 3600 edit events' };
  const clock = clockFor(scanned, fallback.fps, options);
  if (typeof clock === 'string') return { ok: false, error: clock };
  const origin = recordOrigin(scanned, clock, options);
  if (typeof origin === 'string') return { ok: false, error: origin };
  const report = newReport();
  for (const line of scanned.unreadable) report.skipped.push({ element: 'line', name: line, reason: 'not a CMX 3600 event' });
  const unresolved = new Map<string, UnresolvedReference>();
  const ctx: EventContext = {
    pool,
    clock,
    origin,
    recordDrop: scanned.headerDrop,
    projectFps: rateFromNumber(fallback.fps),
    report,
    unresolved,
    matches: new Map(),
    sourceNotes: sourceNoteLog(),
  };
  const clips = scanned.events.flatMap((event) => event.lines.flatMap((_, index) => lineToClips(event, index, ctx)));
  report.warnings.push(...ctx.sourceNotes.warnings());
  for (const event of scanned.events.filter((candidate) => candidate.split)) {
    report.warnings.push(`event ${event.lines[0]!.number}: the SPLIT audio/video delay is not applied`);
  }
  if (unresolved.size) return { ok: false, error: 'EDL media references are unresolved', unresolved: [...unresolved.values()] };
  const reconciled = reconcileClips(clips, report);
  if (!reconciled.length) return { ok: false, error: 'EDL has no importable events', skipped: report.skipped };
  return {
    ok: true,
    timeline: {
      name: scanned.title || 'Imported EDL',
      fps: fallback.fps,
      sourceFps: toNumber(clock.fps),
      width: fallback.width,
      height: fallback.height,
      clips: reconciled,
      warnings: report.warnings,
      skipped: report.skipped,
      startTimecode: clock.label(origin),
    },
  };
}
