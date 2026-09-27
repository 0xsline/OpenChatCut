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
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import { sourceWindowForTimelineRange, timelineFramesToSourceFrames } from '../editor/sourceLimit';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from './motionGraphicRefs';
import { safeSourceFilename, stripInvalidXml10Characters } from '../media/sourceFilename';
import { backgroundFillStrengthOf, isBackgroundFillActive } from '../editor/backgroundFill';
import type { ExportMediaSourceMap, ExportMediaStart } from '../../shared/export-media-sources';
import { planAssetMedia, type AssetMedia } from './fcpxmlMedia';
import { mediaStartTime, mediaTime, rationalTime, retimedClipTimes, timecodeFormatAttr } from './fcpxmlTime';

export { resolveAssetAbsPath, resolveAssetSrc } from './fcpxmlMedia';

/**
 * Transcript editing of audio files (word deletion/mute/block rearrangement) is split into multiple segments at the playback layer
 * (AudioClip of TimelineComposition), the export must be split into the same multiple asset-clips —
 * Otherwise, NLE will play according to the continuous source interval, and the deleted words will be played back, and the entire subsequent content will be lost.
 * Share keptSegments with the rendering layer to ensure that both sides always have the same true source.
 * Deleting words from video files does not change the picture (plays continuously forever), so only audio needs to be segmented.
 * The JianYing draft request splits word-driven audio with this same function.
 */
export function transcriptSegments(
  item: TimelineItem,
  fps: number,
): ReturnType<typeof keptSegments> | null {
  if (item.kind !== 'audio' || !hasOperationalTranscript(item)) return null;
  return keptSegments(item.transcript, new Set(item.deletedWordIdx ?? []), fps, item.startFrame, {
    ...itemEditOpts(item),
    window: itemWindow(item),
  });
}

/** XML 1.0 character filtering plus attribute/text escaping. */
function escapeXml(raw: string): string {
  return stripInvalidXml10Characters(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XML comments cannot contain "--"; the placeholder description is for human viewing, so it is easiest to replace the hyphen directly. */
function xmlComment(text: string): string {
  return `<!-- ${stripInvalidXml10Characters(text).replace(/-/g, '_')} -->`;
}

/** FCPXML resource/element id must be legal NCName: illegal character replacement + fixed prefix guaranteed not to start with a number.*/
function sanitizeId(raw: string): string {
  return `id-${raw.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

function validateState(state: TimelineState): void {
  if (!state || !Array.isArray(state.items)) {
    throw new Error('timelineToFcpxml: state.items 必须是数组');
  }
  if (!Number.isFinite(state.fps) || state.fps <= 0) {
    throw new Error('timelineToFcpxml: state.fps 必须是正数');
  }
  if (!Number.isInteger(state.width) || state.width <= 0 || !Number.isInteger(state.height) || state.height <= 0) {
    throw new Error('timelineToFcpxml: state.width/height 必须是正整数');
  }
  for (const item of state.items) {
    if (!Number.isInteger(item.startFrame) || item.startFrame < 0) {
      throw new Error(`timelineToFcpxml: item ${item.id} 的 startFrame 非法`);
    }
    if (!Number.isInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      throw new Error(`timelineToFcpxml: item ${item.id} 的 durationInFrames 非法`);
    }
  }
}

/** Track → FCPXML lane: Bottom video track (V1)=lane 1, each track above +1; A1=lane -1,
 * -1 for each track down (negative convention: audio hangs below the main line). Unknown track pockets into video lane 1.*/
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
  name: string;
  sourceFilename?: string;
  originalFilePath?: string;
}

interface RenderedMotionGraphicInfo {
  id: string;
  key: string;
  filename: string;
  durationFrames: number;
}

/** An asset with its media representations and clock settled for this export. */
interface PlannedAsset extends AssetInfo {
  readonly media: AssetMedia;
}

/** Press src to remove duplicates and collect asset resources: only one asset will be registered if the same asset is used multiple times on the timeline.*/
function collectAssets(state: TimelineState): Map<string, AssetInfo> {
  const bySrc = new Map<string, AssetInfo>();
  for (const item of state.items) {
    if (!item.src) continue;
    // The source interval used in segmented parts is determined by the last paragraph, which may far exceed the duration after editing (word deletion removes the middle)
    const segs = transcriptSegments(item, state.fps);
    const usedTo = segs?.length
      ? Math.max(...segs.map((seg) => seg.srcEndFrame))
      : sourceWindowForTimelineRange(item, 0, item.durationInFrames).endFrame;
    const libraryAsset = state.assets?.find((asset) => asset.src === item.src);
    const full = Math.max(usedTo, libraryAsset?.durationInFrames ?? 0);
    const existing = bySrc.get(item.src);
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, full);
      // hasVideo/hasAudio are derived from `kind` downstream. The FIRST item
      // referencing a src used to fix it, so a src placed as audio and also as
      // video exported an audio-only asset — the video clip then imported as
      // black. Prefer the visual kind when the same file is used both ways.
      if (existing.kind === 'audio' && item.kind !== 'audio') existing.kind = item.kind;
    } else {
      const sourceFilename = safeSourceFilename(libraryAsset?.sourceFilename)
        ?? safeSourceFilename(item.sourceFilename);
      bySrc.set(item.src, {
        id: sanitizeId(libraryAsset?.id ?? item.id),
        kind: item.kind,
        durationFrames: full,
        name: sourceFilename ?? libraryAsset?.name ?? decodedBasename(item.src),
        sourceFilename,
        originalFilePath: libraryAsset?.originalFilePath ?? item.originalFilePath,
      });
    }
  }
  return bySrc;
}

function decodedBasename(src: string): string {
  const basename = src.replace(/\\/g, '/').split('/').pop() || src;
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function finalExtensionStem(filename: string): string {
  const basename = safeSourceFilename(filename);
  if (!basename) return '';
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(0, dot) : basename;
}


/** `<!ELEMENT media-rep (bookmark?)>`: the location lives only in `src`. */
function mediaRepXml(
  kind: 'original-media' | 'proxy-media',
  src: string,
  filename: string,
): string {
  const suggested = finalExtensionStem(filename);
  const suggestedAttr = suggested ? ` suggestedFilename="${escapeXml(suggested)}"` : '';
  return `<media-rep kind="${kind}" src="${escapeXml(src)}"${suggestedAttr}/>`;
}

/** Settle every asset's media representations and start timecode once. */
function planAssets(
  assets: Map<string, AssetInfo>,
  mediaDir: string | undefined,
  mediaSources: ExportMediaSourceMap | undefined,
): Map<string, PlannedAsset> {
  return new Map(Array.from(assets, ([src, info]) => {
    const located = mediaSources && Object.hasOwn(mediaSources, src) ? mediaSources[src] : undefined;
    return [src, { ...info, media: planAssetMedia(src, info.originalFilePath, mediaDir, located) }];
  }));
}

function assetResourceXml(src: string, asset: PlannedAsset, fps: number, formatId: string): string {
  const hasVideo = asset.kind !== 'audio';
  const hasAudio = asset.kind === 'audio' || asset.kind === 'video';
  const name = escapeXml(asset.name || decodedBasename(src));
  const formatAttr = hasVideo ? ` format="${formatId}"` : '';
  const { originalHref, proxyHref, start } = asset.media;
  const filename = asset.sourceFilename ?? asset.name;
  const representations = [
    mediaRepXml('original-media', originalHref, filename),
    ...(proxyHref ? [mediaRepXml('proxy-media', proxyHref, filename)] : []),
  ];
  return `<asset id="${asset.id}" name="${name}" start="${mediaStartTime(start)}" duration="${rationalTime(asset.durationFrames, fps)}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="${hasAudio ? 1 : 0}"${formatAttr}>\n      ${representations.join('\n      ')}\n    </asset>`;
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
  const href = `file:./${encodeURIComponent(info.filename)}`;
  return `<asset id="${info.id}" name="${escapeXml(info.filename)}" start="0s" duration="${rationalTime(info.durationFrames, fps)}" hasVideo="1" hasAudio="0" format="${formatId}">\n      ${mediaRepXml('original-media', href, info.filename)}\n    </asset>`;
}


function backgroundFillMetadataXml(item: TimelineItem): string {
  return `<metadata>
          <md key="com.openchatcut.backgroundFill" value="1" editable="1" type="boolean"/>
          <md key="com.openchatcut.backgroundFillStrength" value="${backgroundFillStrengthOf(item)}" editable="1" type="integer"/>
        </metadata>`;
}
/** Entries with src (video/audio/image/gif) → asset-clip; entries without src
 * (motion-graphic/text, MG does not have real media files) → a named placeholder gap in a connected
 * storyline on the item's lane. export_motion_graphic_prores can render the transparent video to replace it.*/
/** Source frames consumed by a rate-stretched clip: timeline frames × rate. */
export function retimeSourceFrames(item: TimelineItem): number {
  return timelineFramesToSourceFrames(item, item.durationInFrames);
}

/** A retimed clip's `start` and the `<timeMap>` that goes with it. */
interface Retime {
  readonly start: string;
  readonly xml: string;
}

/**
 * `<timeMap>` for a constant speed change. The clip's rate was previously
 * dropped entirely, so a 2× clip imported at 1× and showed only the first half
 * of its source span; then the map started at 0 while `start` held the source
 * in-point, so an NLE sampled speed × in-point. The map now starts at the
 * media's origin and `start` is in the retimed clock (retimedClipTimes), so
 * the clip's first frame samples the in-point. NOTE: the emitted XML has not
 * been round-tripped through Final Cut or Resolve here, so the intended rate
 * is also written as a comment for the integrator to sanity-check.
 */
function retimeOf(item: TimelineItem, fps: number, start: ExportMediaStart | undefined): Retime | null {
  const rate = item.playbackRate ?? 1;
  if (!Number.isFinite(rate) || rate === 1 || rate <= 0) return null;
  const sourceFrames = retimeSourceFrames(item);
  if (!Number.isFinite(sourceFrames) || sourceFrames <= 0) return null;
  // The same floor timelineFramesToSourceFrames applies to playback.
  const times = retimedClipTimes(start, item.srcInFrame ?? 0, item.durationInFrames, Math.max(0.01, rate), fps);
  return {
    start: times.start,
    xml: [
      xmlComment(`speed change ${rate}x: ${item.durationInFrames} timeline frames consume ${Math.round(sourceFrames)} source frames`),
      '<timeMap>',
      `  <timept time="${times.origin}" value="${times.origin}" interp="linear"/>`,
      `  <timept time="${times.endTime}" value="${times.endValue}" interp="linear"/>`,
      '</timeMap>',
    ].join('\n        '),
  };
}

function itemToSpineElement(
  item: TimelineItem,
  fps: number,
  lane: number,
  assets: Map<string, PlannedAsset>,
  renderedMotionGraphics: Map<string, RenderedMotionGraphicInfo>,
  backgroundFillActive: boolean,
): string {
  const offset = rationalTime(item.startFrame, fps);
  const duration = rationalTime(item.durationInFrames, fps);
  const name = escapeXml(item.name);
  if (item.src) {
    const asset = assets.get(item.src);
    const ref = asset?.id ?? '';
    // In-points count from the file's own start timecode (asset time).
    const start = asset?.media.start;
    const tcFormat = timecodeFormatAttr(start);
    const segs = transcriptSegments(item, fps);
    if (segs?.length) {
      // One clip for each reserved segment:offset is already the absolute frame of the timeline (keptSegments passed in startFrame)
      return segs
        .map((seg) => `<asset-clip ref="${ref}" lane="${lane}" offset="${rationalTime(seg.fromFrame, fps)}" duration="${rationalTime(seg.durFrames, fps)}" start="${mediaTime(start, seg.srcStartFrame, fps)}" name="${name}"${tcFormat}/>`)
        .join('\n        ');
    }
    const retime = retimeOf(item, fps, start);
    const clipStart = retime?.start ?? mediaTime(start, item.srcInFrame ?? 0, fps);
    const attributes = `ref="${ref}" lane="${lane}" offset="${offset}" duration="${duration}" start="${clipStart}" name="${name}"${tcFormat}`;
    const children = [retime?.xml ?? '', backgroundFillActive ? backgroundFillMetadataXml(item) : '']
      .filter(Boolean)
      .join('\n        ');
    return children
      ? `<asset-clip ${attributes}>
        ${children}
      </asset-clip>`
      : `<asset-clip ${attributes}/>`;
  }
  if (item.kind === 'motion-graphic') {
    const rendered = renderedMotionGraphics.get(motionGraphicRenderKey(item));
    if (rendered) {
      return `<asset-clip ref="${rendered.id}" lane="${lane}" offset="${offset}" duration="${duration}" start="0s" name="${name}"/>`;
    }
  }
  // A gap cannot be anchored or carry a lane (it is a clip_item, not an
  // anchor_item), so the placeholder rides in a connected secondary storyline,
  // whose children are timed from the storyline's own start.
  const placeholder = `<gap name="MG: ${name}" offset="0s" duration="${duration}">${xmlComment(`motion graphic placeholder, render before NLE import: ${name}`)}</gap>`;
  return `<spine lane="${lane}" offset="${offset}" name="MG: ${name}">${placeholder}</spine>`;
}

/**
 * Serialize the current timeline into an FCPXML 1.10 document (Final Cut Pro / DaVinci Resolve /
 * Can be read by any Premiere converted by Resolve).
 *
 * Structure: <fcpxml> → <resources>(one <format> + one <asset> for each deduplicated src)
 * → <library><event><project><sequence><spine>. Use a spine that covers the entire length
 * Background <gap> When the main line (lane 0), each item is used as its lane child node, and offset is used
 * Timeline absolute frame conversion - because the background gap itself starts from 0 and covers the entire length, the lane child node
 * "Relative anchor point offset" is numerically equal to the absolute offset, and there is no need to calculate additional relative coordinates. This is a simplified multitrack
 * OpenChatCut timeline (independent absolute frame bits for each track) to FCPX magnetic timeline (connected clips with lane)
 * Direct mapping method; implemented according to FCPXML specification.
 */
export type NleFormat = 'fcp_xml' | 'fcp_xml_resolve';

export interface FcpxmlExportOptions {
  title?: string;
  nleFormat?: NleFormat;
  /** Render keys returned by export_motion_graphic_prores filenameMode=xml. */
  motionGraphicRenderKeys?: string[];
  /** The absolute disk path of the asset directory (server uploadDir()); by default, /media/uploads is output as is,
   *NLE will mark all assets as offline. The caller should fetch from the mediaDir of /api/keys. */
  mediaDir?: string;
  /**
   * Export-time disk locations and start timecodes keyed by item src (POST
   * /api/export-media-sources); they override the mediaDir guess and put asset
   * and clip times on each file's own timecode.
   */
  mediaSources?: ExportMediaSourceMap;
}

export function fcpxmlBackgroundFillCount(state: TimelineState): number {
  return state.items.filter((item) => isBackgroundFillActive(state, item)).length;
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
  const assets = planAssets(collectAssets(state), opts.mediaDir, opts.mediaSources);
  const renderedMotionGraphics = collectRenderedMotionGraphics(state, opts.motionGraphicRenderKeys ?? []);

  const formatId = 'fmt1';
  // Resolve prefers an explicit colorSpace on <format>; Premiere path keeps the
  // leaner attribute set for fcp_xml than fcp_xml_resolve.
  const formatXml = nle === 'fcp_xml_resolve'
    ? `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}" colorSpace="1-1-1 (Rec. 709)"/>`
    : `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}"/>`;
  const assetXmls = Array.from(assets, ([src, asset]) => assetResourceXml(src, asset, fps, formatId));
  const motionGraphicXmls = Array.from(renderedMotionGraphics.values())
    .map((info) => motionGraphicResourceXml(info, fps, formatId));
  const resourcesXml = [formatXml, ...assetXmls, ...motionGraphicXmls].join('\n    ');

  const sortedItems = [...state.items].sort((a, b) => {
    const laneDiff = laneOf(b.track) - laneOf(a.track);
    return laneDiff !== 0 ? laneDiff : a.startFrame - b.startFrame;
  });
  const backgroundFillWarning = fcpxmlBackgroundFillCount(state) > 0
    ? xmlComment('WARNING: backgroundFill settings are preserved as OpenChatCut metadata, but this exporter does not synthesize a portable blurred layer; render a video master to preserve the exact appearance.')
    : '';
  const itemXml = sortedItems
    .map((item) => itemToSpineElement(
      item, fps, laneOf(item.track), assets, renderedMotionGraphics, isBackgroundFillActive(state, item),
    ));
  const spineChildren = [backgroundFillWarning, ...itemXml].filter(Boolean).join('\n        ');

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
