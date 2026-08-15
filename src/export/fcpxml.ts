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
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from './motionGraphicRefs';
import { safeSourceFilename, stripInvalidXml10Characters } from '../media/sourceFilename';
import { backgroundFillStrengthOf, isBackgroundFillActive } from '../editor/backgroundFill';

/** Asset URL prefix: it is in mediaDir on the disk and has the same name. */
const UPLOAD_PREFIX = '/media/uploads/';

/** Absolute disk path → file:// URL. Both POSIX and Windows drive letters are covered; path segmentation is based on URL rules
 * Encoding (Chinese/space file names cannot be parsed by NLE if they are not encoded), and the colon in the drive letter must remain intact. */
function toFileUrl(absPath: string): string {
  const slashed = absPath.replace(/\\/g, '/');
  if (slashed.startsWith('//')) {
    const encoded = slashed.slice(2).split('/').map(encodeURIComponent).join('/');
    return `file://${encoded}`;
  }
  const rooted = /^[A-Za-z]:/.test(slashed) ? `/${slashed}` : slashed;
  const encoded = rooted
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file://${encoded}`;
}
/**
 * Absolute disk path → FCPXML <pathurl>. DaVinci Resolve reads this element
 * per the FCPXML spec, and on macOS it resolves native UTF-8 path segments but
 * NOT percent-encoded non-ASCII. Keep every segment byte-identical to the
 * on-disk name; encode only URL-breaking characters (space/#/?).
 */
export function toPathUrl(absPath: string): string {
  const slashed = absPath.replace(/\\/g, '/');
  const rooted = slashed.startsWith('//') || /^[A-Za-z]:/.test(slashed)
    ? `/${slashed}`.replace(/^\/\//, '//')
    : slashed;
  const encoded = rooted
    .split('/')
    .map((seg) => seg.replace(/ /g, '%20').replace(/#/g, '%23').replace(/\?/g, '%3F'))
    .join('/');
  return `file://${encoded}`;
}

/**
 * Fragment src → absolute disk path when the fragment names a local file.
 * /media/uploads/<name> resolves against mediaDir (MEDIA_DIR can change);
 * Windows/POSIX absolute sources pass through; remote/inline sources return
 * null so callers never fabricate a local address for them.
 */
export function resolveAssetAbsPath(src: string, mediaDir?: string): string | null {
  if (/^(?:https?|file|data|blob):/i.test(src)) return null;
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(src)) return src;
  if (mediaDir && src.startsWith(UPLOAD_PREFIX)) {
    const name = decodeURIComponent(src.slice(UPLOAD_PREFIX.length));
    return `${mediaDir.replace(/[/\\]+$/, '')}/${name}`;
  }
  return src.startsWith('/') ? src : null;
}

/**
 * Fragment src → NLE address that can be relinked. `/media/uploads/<name>` is the same origin URL, the physical location is
 * mediaDir is determined (MEDIA_DIR can be changed) and must be converted into an absolute path, otherwise every asset in NLE is
 * Offline. Remote/inline addresses are passed through as is (NLE can't turn them off, but lying about local paths is worse).
 */
export function resolveAssetSrc(src: string, mediaDir?: string): string {
  if (/^(?:https?|file|data|blob):/i.test(src)) return src;
  const abs = resolveAssetAbsPath(src, mediaDir);
  if (abs) return toFileUrl(abs);
  return `file://${src}`;
}

/**
 * Transcript editing of audio files (word deletion/mute/block rearrangement) is split into multiple segments at the playback layer
 * (AudioClip of TimelineComposition), the export must be split into the same multiple asset-clips —
 * Otherwise, NLE will play according to the continuous source interval, and the deleted words will be played back, and the entire subsequent content will be lost.
 * Share keptSegments with the rendering layer to ensure that both sides always have the same true source.
 * Deleting words from video files does not change the picture (plays continuously forever), so only audio needs to be segmented.
 */
function transcriptSegments(
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

/**
 * Frame → FCPXML rational number time "N/Ds". Integer frame rate directly uses frames/fps; non-integer frame rate
 * (For example, 29.97) Amplify to the integer denominator and then round to an integer to ensure that it is exactly equivalent to frames/fps seconds——
 * Here is the simplest way to ensure accurate round-trip conversion, without pursuing NTSC 1001/30000
 * industry practice denominator.
 */
function rationalTime(frames: number, fps: number): string {
  if (Number.isInteger(fps)) return `${frames}/${fps}s`;
  const scale = 1000;
  return `${Math.round(frames * scale)}/${Math.round(fps * scale)}s`;
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


function mediaRepXml(
  kind: 'original-media' | 'proxy-media',
  src: string,
  filename: string,
  pathUrl?: string,
): string {
  const suggested = finalExtensionStem(filename);
  const suggestedAttr = suggested ? ` suggestedFilename="${escapeXml(suggested)}"` : '';
  const inner = pathUrl ? `<pathurl>${escapeXml(pathUrl)}</pathurl>` : '';
  return `<media-rep kind="${kind}" src="${escapeXml(src)}"${suggestedAttr}>${inner}</media-rep>`;
}

function assetResourceXml(
  src: string,
  info: AssetInfo,
  fps: number,
  formatId: string,
  mediaDir?: string,
): string {
  const hasVideo = info.kind !== 'audio';
  const hasAudio = info.kind === 'audio' || info.kind === 'video';
  const name = escapeXml(info.name || decodedBasename(src));
  const formatAttr = hasVideo ? ` format="${formatId}"` : '';
  const internalAbs = resolveAssetAbsPath(src, mediaDir);
  const internalHref = resolveAssetSrc(src, mediaDir);
  const originalAbs = typeof info.originalFilePath === 'string' && info.originalFilePath
    ? info.originalFilePath
    : undefined;
  const originalHref = originalAbs ? toFileUrl(originalAbs) : undefined;
  const filename = info.sourceFilename ?? info.name;
  const representations = originalHref
    ? [
        mediaRepXml('original-media', originalHref, filename, toPathUrl(originalAbs!)),
        ...(originalHref === internalHref
          ? []
          : [mediaRepXml('proxy-media', internalHref, filename, internalAbs ? toPathUrl(internalAbs) : undefined)]),
      ]
    : [mediaRepXml('original-media', internalHref, filename, internalAbs ? toPathUrl(internalAbs) : undefined)];
  return `<asset id="${info.id}" name="${name}" start="0s" duration="${rationalTime(info.durationFrames, fps)}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="${hasAudio ? 1 : 0}"${formatAttr}>\n      ${representations.join('\n      ')}\n    </asset>`;
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
 * (motion-graphic/text, MG does not have real media files) → placeholder gap with name + annotation,
 * The integrator can use export_motion_graphic_prores to render the transparent video and replace this gap.*/
function itemToSpineElement(
  item: TimelineItem,
  fps: number,
  lane: number,
  assets: Map<string, AssetInfo>,
  renderedMotionGraphics: Map<string, RenderedMotionGraphicInfo>,
  backgroundFillActive: boolean,
): string {
  const offset = rationalTime(item.startFrame, fps);
  const duration = rationalTime(item.durationInFrames, fps);
  const name = escapeXml(item.name);
  if (item.src) {
    const ref = assets.get(item.src)?.id ?? '';
    const segs = transcriptSegments(item, fps);
    if (segs?.length) {
      // One clip for each reserved segment:offset is already the absolute frame of the timeline (keptSegments passed in startFrame)
      return segs
        .map((seg) => `<asset-clip ref="${ref}" lane="${lane}" offset="${rationalTime(seg.fromFrame, fps)}" duration="${rationalTime(seg.durFrames, fps)}" start="${rationalTime(seg.srcStartFrame, fps)}" name="${name}"/>`)
        .join('\n        ');
    }
    const attributes = `ref="${ref}" lane="${lane}" offset="${offset}" duration="${duration}" start="${rationalTime(item.srcInFrame ?? 0, fps)}" name="${name}"`;
    return backgroundFillActive
      ? `<asset-clip ${attributes}>
        ${backgroundFillMetadataXml(item)}
      </asset-clip>`
      : `<asset-clip ${attributes}/>`;
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
  const assets = collectAssets(state);
  const renderedMotionGraphics = collectRenderedMotionGraphics(state, opts.motionGraphicRenderKeys ?? []);

  const formatId = 'fmt1';
  // Resolve prefers an explicit colorSpace on <format>; Premiere path keeps the
  // leaner attribute set for fcp_xml than fcp_xml_resolve.
  const formatXml = nle === 'fcp_xml_resolve'
    ? `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}" colorSpace="1-1-1 (Rec. 709)"/>`
    : `<format id="${formatId}" name="FFVideoFormatCustom${state.width}x${state.height}p${fps}" frameDuration="${rationalTime(1, fps)}" width="${state.width}" height="${state.height}"/>`;
  const assetXmls = Array.from(assets.entries())
    .map(([src, info]) => assetResourceXml(src, info, fps, formatId, opts.mediaDir));
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
