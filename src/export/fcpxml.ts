// FCPXML serializer (submit_export format=xml, nleFormat fcp_xml/fcp_xml_resolve).
// Pure function: read TimelineState → spit FCPXML 1.10 string. No DOM/fetch/fs, excluding
// Date.now()/Math.random(), the same input always has the same output, which is convenient for headless testing and
// Server/client is reused at both ends. The integrator is responsible for connecting it to the xml branch of submit_export.
import {
  timelineDuration,
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from './motionGraphicRefs';

/** XML Properties/text escape(5 reserved characters). */
function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML Comments cannot contain "--"; The placeholder description is for human eyes, so it is easiest to replace the hyphen directly. */
function xmlComment(text: string): string {
  return `<!-- ${text.replace(/-/g, '_')} -->`;
}

/** FCPXML Resources/element id must be legal NCName:Illegal character replacement + Fixed prefixes are guaranteed not to start with a number. */
function sanitizeId(raw: string): string {
  return `id-${raw.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

/**
 * frame → FCPXML rational number time "N/Ds". Integer frame rate is used directly frames/fps;Non-integer frame rate
 * (such as 29.97) is enlarged to the denominator of an integer and then rounded to ensure the same frames/fps The exact equivalent of seconds——
 * Here is the simplest way of writing that can ensure accurate round-trip conversion. We do not pursue NTSC 1001/30000
 * industry practice denominator.
 */
function rationalTime(frames: number, fps: number): string {
  if (Number.isInteger(fps)) return `${frames}/${fps}s`;
  const scale = 1000;
  return `${Math.round(frames * scale)}/${Math.round(fps * scale)}s`;
}

function validateState(state: TimelineState): void {
  if (!state || !Array.isArray(state.items)) {
    throw new Error('timelineToFcpxml: state.items Must be an array');
  }
  if (!Number.isFinite(state.fps) || state.fps <= 0) {
    throw new Error('timelineToFcpxml: state.fps Must be a positive number');
  }
  if (!Number.isInteger(state.width) || state.width <= 0 || !Number.isInteger(state.height) || state.height <= 0) {
    throw new Error('timelineToFcpxml: state.width/height Must be a positive integer');
  }
  for (const item of state.items) {
    if (!Number.isInteger(item.startFrame) || item.startFrame < 0) {
      throw new Error(`timelineToFcpxml: item ${item.id} of startFrame illegal`);
    }
    if (!Number.isInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      throw new Error(`timelineToFcpxml: item ${item.id} of durationInFrames illegal`);
    }
  }
}

/** Orbit → FCPXML lane: Bottom video track(V1)=lane 1, each track up +1；A1=lane -1，
 * down each rail -1(Negative convention: audio hangs below the main line). Unknown track pocket video lane 1。 */
function buildLaneOf(state: TimelineState): (track: TrackId) => number {
  const ids = timelineTrackIds(state);
  const videoTracks = ids.filter((id) => trackKind(state, id) === 'video');
  const audioTracks = ids.filter((id) => trackKind(state, id) === 'audio');
  return (track: TrackId): number => {
    const vIdx = videoTracks.indexOf(track);
    if (vIdx >= 0) return videoTracks.length - vIdx;
    const aIdx = audioTracks.indexOf(track);
    if (aIdx >= 0) return -(aIdx + 1);
    return 1;
  };
}

interface AssetInfo {
  id: string;
  kind: TimelineItem['kind'];
  durationFrames: number;
}

interface RenderedMotionGraphicInfo {
  id: string;
  key: string;
  filename: string;
  durationFrames: number;
}

/** press src Deduplication collection asset Resources: If the same material is used multiple times on the timeline, only one will be registered. asset。 */
function collectAssets(state: TimelineState): Map<string, AssetInfo> {
  const bySrc = new Map<string, AssetInfo>();
  for (const item of state.items) {
    if (!item.src) continue;
    const usedTo = (item.srcInFrame ?? 0) + item.durationInFrames;
    const libraryAsset = state.assets?.find((a) => a.src === item.src);
    const full = Math.max(usedTo, libraryAsset?.durationInFrames ?? 0);
    const existing = bySrc.get(item.src);
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, full);
    } else {
      bySrc.set(item.src, { id: sanitizeId(item.id), kind: item.kind, durationFrames: full });
    }
  }
  return bySrc;
}

function assetResourceXml(src: string, info: AssetInfo, fps: number, formatId: string): string {
  const hasVideo = info.kind !== 'audio';
  const hasAudio = info.kind === 'audio' || info.kind === 'video';
  const name = escapeXml(src.split('/').pop() || src);
  const formatAttr = hasVideo ? ` format="${formatId}"` : '';
  return `<asset id="${info.id}" name="${name}" src="file://${escapeXml(src)}" start="0s" duration="${rationalTime(info.durationFrames, fps)}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="${hasAudio ? 1 : 0}"${formatAttr}/>`;
}

function collectRenderedMotionGraphics(
  state: TimelineState,
  requestedKeys: readonly string[],
): Map<string, RenderedMotionGraphicInfo> {
  const allowed = new Set(requestedKeys.map((key) => key.trim()).filter(Boolean));
  const rendered = new Map<string, RenderedMotionGraphicInfo>();
  if (!allowed.size) return rendered;
  for (const item of state.items) {
    if (item.kind !== 'motion-graphic' || item.src) continue;
    const key = motionGraphicRenderKey(item);
    if (!allowed.has(key)) continue;
    const existing = rendered.get(key);
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, item.durationInFrames);
      continue;
    }
    rendered.set(key, {
      id: sanitizeId(`mg-${key}`),
      key,
      filename: motionGraphicRenderFilename(key),
      durationFrames: item.durationInFrames,
    });
  }
  return rendered;
}

function motionGraphicResourceXml(
  info: RenderedMotionGraphicInfo,
  fps: number,
  formatId: string,
): string {
  return `<asset id="${info.id}" name="${escapeXml(info.filename)}" src="file:./${escapeXml(info.filename)}" start="0s" duration="${rationalTime(info.durationFrames, fps)}" hasVideo="1" hasAudio="0" format="${formatId}"/>`;
}

/** Yes src entries (video/audio/image/gif）→ asset-clip;no src entry
 * （motion-graphic/text，MG No real media files)→ with name+Placeholder for comments gap，
 * Available for integration export_motion_graphic_prores Replace this segment after rendering the transparent video gap。 */
function itemToSpineElement(
  item: TimelineItem,
  fps: number,
  lane: number,
  assets: Map<string, AssetInfo>,
  renderedMotionGraphics: Map<string, RenderedMotionGraphicInfo>,
): string {
  const offset = rationalTime(item.startFrame, fps);
  const duration = rationalTime(item.durationInFrames, fps);
  const name = escapeXml(item.name);
  if (item.src) {
    const ref = assets.get(item.src)?.id ?? '';
    const start = rationalTime(item.srcInFrame ?? 0, fps);
    return `<asset-clip ref="${ref}" lane="${lane}" offset="${offset}" duration="${duration}" start="${start}" name="${name}"/>`;
  }
  if (item.kind === 'motion-graphic') {
    const rendered = renderedMotionGraphics.get(motionGraphicRenderKey(item));
    if (rendered) {
      return `<asset-clip ref="${rendered.id}" lane="${lane}" offset="${offset}" duration="${duration}" start="0s" name="${name}"/>`;
    }
  }
  return `<gap name="MG: ${name}" lane="${lane}" offset="${offset}" duration="${duration}">${xmlComment(`motion graphic placeholder, render before NLE import: ${name}`)}</gap>`;
}

/**
 * Serialize the current timeline into FCPXML 1.10 Document(Final Cut Pro / DaVinci Resolve /
 * by Resolve changing hands Premiere can all read).
 *
 * Structure:<fcpxml> → <resources>(one piece <format> + Deduplicate each src one piece <asset>)
 * → <library><event><project><sequence><spine>。spine Use one to cover the entire length
 * background <gap> When the main line (lane 0), each item all as its lane child node,offset use
 * Timeline absolute frame conversion - because of the background gap itself from 0 Begin to cover the entire length,lane of child nodes
 * "Relative anchor point offset"The numerical value is equal to the absolute offset, and there is no need to calculate the relative coordinates. This is a simplified multitrack
 * OpenChatCut Timeline (independent absolute frame bits for each track) to FCPX Magnetic Timeline (connect clip strips lane）
 * direct mapping mode; press FCPXML Standard implementation.
 */
export type NleFormat = 'fcp_xml' | 'fcp_xml_resolve';

export interface FcpxmlExportOptions {
  title?: string;
  nleFormat?: NleFormat;
  /** Render keys returned by export_motion_graphic_prores filenameMode=xml. */
  motionGraphicRenderKeys?: string[];
}

export function timelineToFcpxml(
  state: TimelineState,
  opts: FcpxmlExportOptions = {},
): string {
  validateState(state);
  const fps = state.fps;
  const total = timelineDuration(state);
  const title = escapeXml((opts.title ?? '').trim() || 'OpenChatCut Timeline');
  const nle: NleFormat = opts.nleFormat === 'fcp_xml_resolve' ? 'fcp_xml_resolve' : 'fcp_xml';
  const laneOf = buildLaneOf(state);
  const assets = collectAssets(state);
  const renderedMotionGraphics = collectRenderedMotionGraphics(state, opts.motionGraphicRenderKeys ?? []);

  const formatId = 'fmt1';
  // Resolve prefers an explicit colorSpace on <format>; Premiere path keeps the
  // leaner attribute set for fcp_xml than fcp_xml_resolve.
  const formatXml = nle === 'fcp_xml_resolve'
    ? `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}" colorSpace="1-1-1 (Rec. 709)"/>`
    : `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}"/>`;
  const assetXmls = Array.from(assets.entries()).map(([src, info]) => assetResourceXml(src, info, fps, formatId));
  const motionGraphicXmls = Array.from(renderedMotionGraphics.values())
    .map((info) => motionGraphicResourceXml(info, fps, formatId));
  const resourcesXml = [formatXml, ...assetXmls, ...motionGraphicXmls].join('\n    ');

  const sortedItems = [...state.items].sort((a, b) => {
    const laneDiff = laneOf(b.track) - laneOf(a.track);
    return laneDiff !== 0 ? laneDiff : a.startFrame - b.startFrame;
  });
  const spineChildren = sortedItems
    .map((item) => itemToSpineElement(item, fps, laneOf(item.track), assets, renderedMotionGraphics))
    .join('\n        ');

  const backgroundGap = `<gap name="Background" offset="${rationalTime(0, fps)}" duration="${rationalTime(total, fps)}">\n        ${spineChildren}\n      </gap>`;
  const eventName = nle === 'fcp_xml_resolve' ? 'OpenChatCut Export (Resolve)' : 'OpenChatCut Export';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    ${resourcesXml}`,
    '  </resources>',
    '  <library>',
    `    <event name="${eventName}">`,
    `      <project name="${title}">`,
    `        <sequence format="${formatId}" duration="${rationalTime(total, fps)}" tcStart="${rationalTime(0, fps)}" tcFormat="NDF">`,
    '          <spine>',
    `            ${backgroundGap}`,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
  ].join('\n');
}
