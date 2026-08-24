import type { Document as XmlDocument, Element as XmlElement } from '@xmldom/xmldom';
import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { makeDraft } from '../../editor/store';

export const TIMELINE_IMPORT_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'import_timeline',
  description: [
    'Import FCPXML 1.x asset-clip timelines or CMX 3600 EDL text into a new editable OpenChatCut timeline.',
    'Referenced files must already exist in the current media pool; matching uses asset id, original path, source path, source filename, and asset name.',
    'The import preserves track/lane placement, timeline start and duration, source in-point, and file-backed audio clips. Unresolved or ambiguous media aborts the import without changing the project.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['fcpxml', 'edl'], description: 'Interchange format.' },
      content: { type: 'string', description: 'Complete UTF-8 FCPXML or CMX 3600 EDL document text.' },
      name: { type: 'string', description: 'Optional imported timeline name.' },
      activate: { type: 'boolean', description: 'Open the imported timeline after success; default true.' },
    },
    required: ['format', 'content'],
    additionalProperties: false,
  },
}];

export const TIMELINE_IMPORT_TOOL_NAMES = new Set(TIMELINE_IMPORT_TOOL_SCHEMAS.map((tool) => tool.name));

type ImportFormat = 'fcpxml' | 'edl';
type ClipFamily = 'video' | 'audio';

interface ParsedClip {
  name: string;
  assetId: string;
  family: ClipFamily;
  lane: number;
  startFrame: number;
  durationInFrames: number;
  sourceStartFrame: number;
}

interface ParsedTimeline {
  name: string;
  fps: number;
  width: number;
  height: number;
  clips: ParsedClip[];
  warnings: string[];
}

type ParseResult = { ok: true; timeline: ParsedTimeline } | {
  ok: false;
  error: string;
  unresolved?: Array<{ reference: string; reason: string }>;
};
type XmlParserConstructor = typeof import('@xmldom/xmldom').DOMParser;

const MAX_CONTENT_CHARS = 2_000_000;

function attr(element: XmlElement, name: string): string {
  return element.getAttribute(name)?.trim() ?? '';
}

function elements(root: XmlDocument | XmlElement, tag: string): XmlElement[] {
  const nodes = root.getElementsByTagName(tag);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index))
    .filter((node): node is XmlElement => node?.nodeType === 1);
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizedReference(value: string): string {
  return decoded(value.trim()).replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^file:\/\//i, '').toLowerCase();
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

function resolveAsset(
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

function seconds(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?s$/.exec(value.trim());
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] ? Number(match[2]) : 1;
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : null;
}

function timeFrames(value: string, fps: number): number | null {
  const valueSeconds = seconds(value);
  return valueSeconds === null ? null : Math.round(valueSeconds * fps);
}

function fcpxmlAssetReferences(resource: XmlElement): string[] {
  const refs = [attr(resource, 'id'), attr(resource, 'name')];
  for (const mediaRep of elements(resource, 'media-rep')) {
    refs.push(attr(mediaRep, 'src'), attr(mediaRep, 'suggestedFilename'));
  }
  for (const pathUrl of elements(resource, 'pathurl')) refs.push(pathUrl.textContent?.trim() ?? '');
  return refs.filter(Boolean);
}

function parseXml(
  content: string,
  Parser: XmlParserConstructor,
): { document?: XmlDocument; error?: string } {
  const errors: string[] = [];
  try {
    const document = new Parser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(content, 'application/xml');
    if (errors.length || document.documentElement?.tagName !== 'fcpxml') {
      return { error: `invalid FCPXML${errors[0] ? `: ${errors[0]}` : ''}` };
    }
    return { document };
  } catch (error) {
    return { error: `invalid FCPXML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function parseFcpxml(
  content: string,
  assets: readonly MediaAsset[],
  fallback: TimelineState,
  Parser: XmlParserConstructor,
): ParseResult {
  if (/<!ENTITY/i.test(content)) return { ok: false, error: 'FCPXML entity declarations are rejected' };
  const parsedXml = parseXml(content, Parser);
  if (!parsedXml.document) return { ok: false, error: parsedXml.error ?? 'invalid FCPXML' };
  const document = parsedXml.document;
  const sequence = elements(document, 'sequence')[0];
  if (!sequence) return { ok: false, error: 'FCPXML has no sequence' };
  const formatRef = attr(sequence, 'format');
  const format = elements(document, 'format').find((candidate) => attr(candidate, 'id') === formatRef);
  const frameDuration = format ? seconds(attr(format, 'frameDuration')) : null;
  const fps = frameDuration && frameDuration > 0 ? 1 / frameDuration : fallback.fps;
  const width = Number(attr(format ?? sequence, 'width')) || fallback.width;
  const height = Number(attr(format ?? sequence, 'height')) || fallback.height;
  const resources = new Map(elements(document, 'asset').map((resource) => [attr(resource, 'id'), resource]));
  const unresolved: Array<{ reference: string; reason: string }> = [];
  const clips: ParsedClip[] = [];
  for (const clip of elements(sequence, 'asset-clip')) {
    const ref = attr(clip, 'ref');
    const resource = resources.get(ref);
    const references = [ref, attr(clip, 'name'), ...(resource ? fcpxmlAssetReferences(resource) : [])].filter(Boolean);
    const resolved = resolveAsset(assets, references);
    if ('reason' in resolved) {
      unresolved.push({ reference: references.join(' | ') || ref, reason: resolved.reason });
      continue;
    }
    const startFrame = timeFrames(attr(clip, 'offset') || '0s', fps);
    const durationInFrames = timeFrames(attr(clip, 'duration'), fps);
    const sourceStartFrame = timeFrames(attr(clip, 'start') || '0s', fps);
    if (startFrame === null || durationInFrames === null || sourceStartFrame === null || durationInFrames <= 0) {
      return { ok: false, error: `invalid FCPXML timing on ${attr(clip, 'name') || ref}` };
    }
    clips.push({
      name: attr(clip, 'name') || resolved.name,
      assetId: resolved.id,
      family: resolved.kind === 'audio' ? 'audio' : 'video',
      lane: Number(attr(clip, 'lane')) || (resolved.kind === 'audio' ? -1 : 1),
      startFrame: Math.max(0, startFrame),
      durationInFrames,
      sourceStartFrame: Math.max(0, sourceStartFrame),
    });
  }
  if (unresolved.length) return { ok: false, error: 'FCPXML media references are unresolved', unresolved };
  if (!clips.length) return { ok: false, error: 'FCPXML sequence has no importable asset-clip entries' };
  const project = elements(document, 'project')[0];
  return { ok: true, timeline: { name: attr(project ?? sequence, 'name') || 'Imported FCPXML', fps, width, height, clips, warnings: [] } };
}

function edlFrame(value: string, fps: number): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(value);
  if (!match) return null;
  const [hours, minutes, secondsPart, frames] = match.slice(1).map(Number);
  const nominalFps = Math.round(fps);
  if (minutes! > 59 || secondsPart! > 59 || frames! >= nominalFps) return null;
  const frame = ((hours! * 60 + minutes!) * 60 + secondsPart!) * nominalFps + frames!;
  if (!value.includes(';')) return frame;
  if (nominalFps !== 30 && nominalFps !== 60) return null;
  const droppedPerMinute = nominalFps === 60 ? 4 : 2;
  if (secondsPart === 0 && minutes! % 10 !== 0 && frames! < droppedPerMinute) return null;
  const totalMinutes = hours! * 60 + minutes!;
  return frame - droppedPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
}

interface EdlEvent {
  references: string[];
  family: ClipFamily;
  sourceStartFrame: number;
  sourceEndFrame: number;
  recordStartFrame: number;
  recordEndFrame: number;
}

function parseEdlEvent(line: string, fps: number): EdlEvent | null {
  const parts = line.trim().split(/\s+/);
  if (!/^\d{3,6}$/.test(parts[0] ?? '')) return null;
  const timecodes = parts.filter((part) => /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(part));
  if (timecodes.length < 4) return null;
  const frames = timecodes.slice(-4).map((value) => edlFrame(value, fps));
  if (frames.some((value) => value === null)) return null;
  const channel = parts[2]?.toUpperCase() ?? 'V';
  return {
    references: [parts[1] ?? ''],
    family: channel.includes('V') ? 'video' : 'audio',
    sourceStartFrame: frames[0]!,
    sourceEndFrame: frames[1]!,
    recordStartFrame: frames[2]!,
    recordEndFrame: frames[3]!,
  };
}

function parseEdl(content: string, assets: readonly MediaAsset[], fallback: TimelineState): ParseResult {
  const lines = content.replace(/\r/g, '').split('\n');
  const title = lines.find((line) => /^TITLE\s*:/i.test(line))?.replace(/^TITLE\s*:\s*/i, '').trim();
  const fps = fallback.fps;
  const events: EdlEvent[] = [];
  for (const line of lines) {
    const event = parseEdlEvent(line, fps);
    if (event) {
      events.push(event);
      continue;
    }
    const clipName = /^\*\s*(?:FROM CLIP NAME|SOURCE FILE)\s*:\s*(.+)$/i.exec(line)?.[1]?.trim();
    if (clipName && events.length) events[events.length - 1]!.references.push(clipName);
  }
  if (!events.length) return { ok: false, error: 'EDL has no CMX 3600 edit events' };
  const unresolved: Array<{ reference: string; reason: string }> = [];
  const clips: ParsedClip[] = [];
  for (const event of events) {
    const asset = resolveAsset(assets, event.references);
    if ('reason' in asset) {
      unresolved.push({ reference: event.references.join(' | '), reason: asset.reason });
      continue;
    }
    const actualFamily = asset.kind === 'audio' ? 'audio' : 'video';
    if (actualFamily !== event.family) {
      unresolved.push({ reference: event.references.join(' | '), reason: `EDL channel ${event.family} conflicts with asset kind ${asset.kind}` });
      continue;
    }
    clips.push({
      name: event.references.at(-1) || asset.name,
      assetId: asset.id,
      family: event.family,
      lane: event.family === 'audio' ? -1 : 1,
      startFrame: event.recordStartFrame,
      durationInFrames: event.recordEndFrame - event.recordStartFrame,
      sourceStartFrame: event.sourceStartFrame,
    });
  }
  if (unresolved.length) return { ok: false, error: 'EDL media references are unresolved', unresolved };
  if (clips.some((clip) => clip.durationInFrames <= 0)) return { ok: false, error: 'EDL contains a non-positive record duration' };
  return { ok: true, timeline: { name: title || 'Imported EDL', fps, width: fallback.width, height: fallback.height, clips, warnings: [] } };
}

async function xmlParser(): Promise<XmlParserConstructor> {
  if (typeof globalThis.DOMParser === 'function') {
    return globalThis.DOMParser as unknown as XmlParserConstructor;
  }
  return (await import('@xmldom/xmldom')).DOMParser;
}

export async function parseTimelineImport(
  format: ImportFormat,
  content: string,
  assets: readonly MediaAsset[],
  fallback: TimelineState,
): Promise<ParseResult> {
  if (!content.trim()) return { ok: false, error: 'content is required' };
  if (content.length > MAX_CONTENT_CHARS) return { ok: false, error: `content exceeds ${MAX_CONTENT_CHARS} characters` };
  return format === 'fcpxml'
    ? parseFcpxml(content, assets, fallback, await xmlParser())
    : parseEdl(content, assets, fallback);
}

type ImportDraft = ReturnType<typeof makeDraft>;

function createImportTracks(draft: ImportDraft, clips: readonly ParsedClip[]): Map<string, string> {
  const initialVideoTrack = draft.getState().trackOrder?.[0];
  const laneKeys = [...new Set(clips.map((clip) => `${clip.family}:${clip.lane}`))]
    .sort((left, right) => {
      const [leftFamily, leftLane] = left.split(':');
      const [rightFamily, rightLane] = right.split(':');
      if (leftFamily !== rightFamily) return leftFamily === 'video' ? -1 : 1;
      return Number(rightLane) - Number(leftLane);
    });
  const tracks = new Map<string, string>();
  for (const [index, laneKey] of laneKeys.entries()) {
    const [family, lane] = laneKey.split(':') as [ClipFamily, string];
    const track = family === 'video' && !tracks.size && initialVideoTrack
      ? initialVideoTrack
      : draft.commands.createTrack(family, {
        name: `Imported ${family === 'video' ? 'V' : 'A'}${Math.abs(Number(lane))}`,
        order: index,
      });
    tracks.set(laneKey, track);
  }
  return tracks;
}

function buildImportedTimeline(draft: ImportDraft, timeline: ParsedTimeline, name: string) {
  const timelineId = draft.commands.createTimeline({
    name,
    width: timeline.width,
    height: timeline.height,
    activate: true,
  });
  const tracks = createImportTracks(draft, timeline.clips);
  for (const clip of timeline.clips) {
    const asset = draft.getDoc().assets.find((candidate) => candidate.id === clip.assetId)!;
    draft.commands.addMediaItem({ ...asset, durationInFrames: clip.durationInFrames }, {
      track: tracks.get(`${clip.family}:${clip.lane}`),
      startFrame: clip.startFrame,
      srcInFrame: clip.sourceStartFrame,
    });
  }
  const current = draft.getDoc();
  const doc = {
    ...current,
    timelines: current.timelines.map((item) => item.id === timelineId
      ? { ...item, fps: timeline.fps }
      : item),
  };
  return { doc, timelineId, trackCount: tracks.size };
}

export async function execTimelineImportTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<Record<string, unknown>> {
  if (name !== 'import_timeline') return { error: `unknown tool ${name}` };
  const format = args.format === 'fcpxml' || args.format === 'edl' ? args.format : null;
  if (!format) return { error: 'format must be fcpxml or edl' };
  const parsed = await parseTimelineImport(
    format,
    typeof args.content === 'string' ? args.content : '',
    ctx.getDoc().assets,
    ctx.getState(),
  );
  if (!parsed.ok) return parsed;
  const draft = makeDraft(ctx.getDoc());
  const importedName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : parsed.timeline.name;
  const previousTimelineId = draft.getDoc().activeTimelineId;
  const imported = buildImportedTimeline(draft, parsed.timeline, importedName);
  ctx.commands.applyDoc(args.activate === false
    ? { ...imported.doc, activeTimelineId: previousTimelineId }
    : imported.doc);
  return {
    ok: true,
    format,
    timelineId: imported.timelineId,
    name: importedName,
    itemCount: parsed.timeline.clips.length,
    trackCount: imported.trackCount,
    fps: parsed.timeline.fps,
    warnings: parsed.timeline.warnings,
  };
}
