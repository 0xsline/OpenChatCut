// Premiere-oriented Final Cut Pro 7 XML (XMEML) serializer.
// This remains separate from the FCPXML serializer used by Final Cut and Resolve.
import {
  timelineDuration,
  timelineTrackIds,
  trackKind,
  type MediaAsset,
  type TimelineItem,
  type TimelineState,
} from '../editor/types';
import { clipFadeFactor } from '../editor/clipFade';
import { sampleKeyframes } from '../editor/keyframes';
import { planAssetMedia, resolveAssetSrc } from './fcpxmlMedia';
import { safeSourceFilename, stripInvalidXml10Characters } from '../media/sourceFilename';
import type { ExportMediaStart } from '../../shared/export-media-sources';
import type { PremiereBakedMedia, PremiereXmlExportOptions } from './premiereTypes';
import { planPremiereExport } from './premiereBakePlan';
import {
  frameCountToTimecode,
  mediaStartFrame,
  premiereFrameRate,
  premiereRateXml,
  sourceFramesAtTimelineRate,
  type PremiereFrameRateInput,
} from './premiereXmlTime';
import { transcriptSegments } from './fcpxml';

function escapeXml(value: unknown): string {
  return stripInvalidXml10Characters(String(value ?? ''))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function assertState(state: TimelineState): void {
  if (!state || !Array.isArray(state.items)) throw new Error('timelineToPremiereXml: state.items must be an array');
  premiereFrameRate(state.fps);
  if (!Number.isSafeInteger(state.width) || state.width <= 0
    || !Number.isSafeInteger(state.height) || state.height <= 0) {
    throw new Error('timelineToPremiereXml: width and height must be positive integers');
  }
  const ids = new Set<string>();
  for (const item of state.items) {
    if (!item.id || ids.has(item.id)) {
      throw new Error(`timelineToPremiereXml: item ids must be unique (duplicate: ${item.id || '<empty>'})`);
    }
    ids.add(item.id);
    if (!Number.isSafeInteger(item.startFrame) || item.startFrame < 0
      || !Number.isSafeInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      throw new Error(`timelineToPremiereXml: invalid timeline range for item ${item.id}`);
    }
    if (item.srcInFrame !== undefined && (!Number.isFinite(item.srcInFrame) || item.srcInFrame < 0)) {
      throw new Error(`timelineToPremiereXml: invalid source in-point for item ${item.id}`);
    }
  }
}

function basename(value: string): string {
  const raw = value.replace(/\\/g, '/').split('/').pop() || 'Media';
  try { return safeSourceFilename(decodeURIComponent(raw)) ?? safeSourceFilename(raw) ?? 'Media'; }
  catch { return safeSourceFilename(raw) ?? 'Media'; }
}

function assetFor(state: TimelineState, item: TimelineItem): MediaAsset | undefined {
  if (item.sourceAssetId) {
    const byId = state.assets?.find((asset) => asset.id === item.sourceAssetId);
    if (byId) return byId;
  }
  return item.src ? state.assets?.find((asset) => asset.src === item.src) : undefined;
}

function sourceClockStart(asset: MediaAsset | undefined): ExportMediaStart | undefined {
  const clock = asset?.sourceTimecode;
  if (!clock || clock.frameCount <= 0) return undefined;
  const { numerator, denominator } = clock.frameRate;
  return {
    value: clock.frameCount * denominator,
    timescale: numerator,
    timecode: frameCountToTimecode(clock.frameCount, clock.frameRate, clock.dropFrame),
    dropFrame: clock.dropFrame,
  };
}

interface ResolvedMedia {
  readonly key: string;
  readonly pathurl: string;
  readonly name: string;
  readonly rate: PremiereFrameRateInput;
  readonly start?: ExportMediaStart;
  readonly kind: TimelineItem['kind'];
  readonly hasAudio: boolean;
  readonly width?: number;
  readonly height?: number;
}

interface MediaResource {
  readonly id: string;
  media: ResolvedMedia;
  durationFrames: number;
}

function mediaFor(
  state: TimelineState,
  item: TimelineItem,
  src: string,
  kind: TimelineItem['kind'],
  opts: PremiereXmlExportOptions,
  asset: MediaAsset | undefined,
  baked: boolean,
): ResolvedMedia {
  const located = opts.mediaSources?.[src];
  // Baked files are already complete clip-local outputs: resolve the bake's
  // own address and never let a timeline item's camera-original override it.
  const originalPath = baked ? undefined : asset?.originalFilePath ?? item.originalFilePath;
  const planned = planAssetMedia(src, originalPath, opts.mediaDir, located);
  const declaredOriginalHref = originalPath ? resolveAssetSrc(originalPath) : undefined;
  const serverOriginalHref = located?.originalPath ? resolveAssetSrc(located.originalPath) : undefined;
  const locatedPathHref = located?.path ? resolveAssetSrc(located.path) : undefined;
  const resolvedFromServerOriginal = !!serverOriginalHref && planned.originalHref === serverOriginalHref;
  const resolvedFromServerPath = !!locatedPathHref && planned.originalHref === locatedPathHref;
  const resolvedFromDeclaredOriginal = !!declaredOriginalHref && planned.originalHref === declaredOriginalHref;
  // Rate metadata follows the exact file selected by planAssetMedia. In-place
  // originals can also be `path`, while a managed proxy may resolve to the
  // separate `originalPath` and must use originalRate rather than proxy FPS.
  const measuredRate = resolvedFromServerOriginal
    ? located?.originalRate ?? (resolvedFromServerPath ? located?.pathRate : undefined)
    : resolvedFromDeclaredOriginal
      ? located?.originalRate ?? (resolvedFromServerPath ? located?.pathRate : undefined)
      : resolvedFromServerPath || !serverOriginalHref
      ? located?.pathRate
      : undefined;
  // The ingest clock is a safe rate fallback only for an original, never for a
  // distinct normalized/proxy representation.
  const fallbackRate = (resolvedFromServerOriginal || resolvedFromDeclaredOriginal || !located?.originalPath && !located?.path)
    ? asset?.sourceTimecode?.frameRate
    : undefined;
  const isStill = kind === 'image' || kind === 'gif' || kind === 'svg';
  const rate: PremiereFrameRateInput = baked ? state.fps : measuredRate ?? fallbackRate ?? state.fps;
  if (kind === 'video' && !baked && !measuredRate && !fallbackRate) {
    throw new Error(`Premiere XML cannot determine the native frame rate for video item ${item.id} (${src})`);
  }
  const pathurl = planned.originalHref;
  if (!pathurl.startsWith('file:')) throw new Error(`Premiere XML requires a local file path for item ${item.id}`);
  const start = baked ? undefined : planned.start ?? sourceClockStart(asset);
  const name = safeSourceFilename(asset?.sourceFilename)
    ?? safeSourceFilename(item.sourceFilename)
    ?? basename(src);
  return {
    key: pathurl,
    pathurl,
    name,
    rate: isStill && !baked ? state.fps : rate,
    ...(start ? { start } : {}),
    kind,
    hasAudio: kind === 'audio' || kind === 'video' && !baked,
    ...(asset?.width ? { width: asset.width } : {}),
    ...(asset?.height ? { height: asset.height } : {}),
  };
}

function bakedFor(item: TimelineItem, opts: PremiereXmlExportOptions): PremiereBakedMedia | undefined {
  return opts.bakedMedia?.[item.id];
}

function requireBakes(state: TimelineState, opts: PremiereXmlExportOptions): void {
  const plan = planPremiereExport(state);
  const blocker = plan.issues.find((issue) => {
    if (issue.severity !== 'error') return false;
    const prerequisite = issue.code === 'premiere-motion-graphic-code-missing'
      || issue.code === 'premiere-visual-bake-source-missing'
      || issue.code === 'premiere-audio-bake-source-missing';
    if (!prerequisite) return true;
    if (!issue.itemIds.length) return true;
    return issue.itemIds.some((itemId) => {
      const baked = opts.bakedMedia?.[itemId];
      return issue.code === 'premiere-audio-bake-source-missing'
        ? !baked?.audioSrc
        : !baked?.visualSrc;
    });
  });
  if (blocker) throw new Error(`${blocker.message}${blocker.itemIds.length ? ` (items: ${blocker.itemIds.join(', ')})` : ''}`);
  for (const job of plan.bakeJobs) {
    const media = opts.bakedMedia?.[job.itemId];
    const source = job.kind === 'visual' ? media?.visualSrc : media?.audioSrc;
    if (!source) throw new Error(`Premiere XML is missing the required ${job.kind} bake for item ${job.itemId}`);
  }
  for (const item of state.items) {
    const speed = item.playbackRate ?? 1;
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error(`Premiere XML requires a positive finite playback rate for item ${item.id}`);
    }
  }
}

interface ClipRecord {
  readonly id: string;
  readonly item: TimelineItem;
  readonly media: MediaResource;
  readonly start: number;
  readonly duration: number;
  clipDuration: number;
  readonly inFrame: number;
  readonly outFrame: number;
  readonly rate: PremiereFrameRateInput;
  readonly trackIndex: number;
  readonly mediaType: 'video' | 'audio';
  peer?: { id: string; mediaType: 'video' | 'audio'; trackIndex: number };
  clipIndex?: number;
  filters?: string;
  retime?: { readonly window: RetimeWindow; readonly mediaType: 'video' | 'audio' };
}

function timecodeXml(media: ResolvedMedia, indent: string): string {
  if (!media.start) return '';
  const frame = mediaStartFrame(media.start, media.rate);
  const timecode = media.start.timecode ?? frameCountToTimecode(frame, media.rate, media.start.dropFrame);
  return [
    `${indent}<timecode>`,
    `${indent}  ${premiereRateXml(media.rate, `${indent}  `)}`,
    `${indent}  <string>${escapeXml(timecode)}</string>`,
    `${indent}  <frame>${frame}</frame>`,
    `${indent}  <displayformat>${media.start.dropFrame ? 'DF' : 'NDF'}</displayformat>`,
    `${indent}</timecode>`,
  ].join('\n');
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Premiere XML cannot serialize a non-finite effect value');
  return String(Number(value.toFixed(6)));
}

function keyframeXml(when: number, value: number): string {
  return [
    '<keyframe>',
    `  <when>${when}</when>`,
    `  <value>${decimal(value)}</value>`,
    '  <interpolation><name>FCPCurve</name></interpolation>',
    '</keyframe>',
  ].join('\n');
}

function audioLevelsFilter(
  item: TimelineItem,
  streamRate: PremiereFrameRateInput,
  timelineRate: PremiereFrameRateInput,
  adjustedIn: number,
  segmentStart: number,
  segmentDuration: number,
): string {
  const volumeKeys = item.keyframes?.volume ?? [];
  const fadeIn = item.fadeInFrames ?? 0;
  const fadeOut = item.fadeOutFrames ?? 0;
  const gain = item.volume ?? 1;
  if (!volumeKeys.length && fadeIn <= 0 && fadeOut <= 0 && gain === 1) return '';

  const from = segmentStart - item.startFrame;
  const to = from + segmentDuration;
  const hasFade = fadeIn > 0 || fadeOut > 0;
  const sampleLevel = (frame: number): number => {
    const base = volumeKeys.length
      ? sampleKeyframes(volumeKeys, frame)
      : gain;
    return base * (hasFade ? clipFadeFactor(frame, item.durationInFrames, fadeIn, fadeOut) : 1);
  };
  const points = new Map<number, number>();
  const addPoint = (itemLocalFrame: number): void => {
    const bounded = Math.max(from, Math.min(to, itemLocalFrame));
    const local = bounded - from;
    const when = adjustedIn + sourceFramesAtTimelineRate(local, streamRate, timelineRate);
    points.set(when, sampleLevel(bounded));
  };
  if (hasFade) {
    addPoint(from);
    addPoint(to);
    if (fadeIn > 0) addPoint(fadeIn);
    if (fadeOut > 0) addPoint(item.durationInFrames - fadeOut);
    if (fadeIn + fadeOut > item.durationInFrames && fadeIn + fadeOut > 0) {
      addPoint(item.durationInFrames * fadeIn / (fadeIn + fadeOut));
    }
  } else if (volumeKeys.length) {
    addPoint(from);
    addPoint(to);
    for (const keyframe of volumeKeys) {
      if (keyframe.frame > from && keyframe.frame < to) addPoint(keyframe.frame);
    }
  }
  const frames = [...points.entries()].sort(([a], [b]) => a - b);
  const parameterValue = frames.length > 1
    ? frames.map(([when, value]) => `              ${keyframeXml(when, value).replace(/\n/g, '\n              ')}`).join('\n')
    : `<value>${decimal(frames[0]?.[1] ?? gain)}</value>`;
  return [
    '<filter>',
    '  <effect>',
    '    <name>Audio Levels</name>',
    '    <effectid>audiolevels</effectid>',
    '    <effectcategory>audiolevels</effectcategory>',
    '    <effecttype>audiolevels</effecttype>',
    '    <mediatype>audio</mediatype>',
    '    <parameter authoringApp="PremierePro">',
    '      <parameterid>level</parameterid>',
    '      <name>Level</name>',
      parameterValue.split('\n').map((line) => `      ${line}`).join('\n'),
    '      <pproBypass>false</pproBypass>',
    '    </parameter>',
    '  </effect>',
    '</filter>',
  ].join('\n');
}

function basicMotionScaleFilter(scalePercent: number): string {
  return [
    '<filter>',
    '  <effect>',
    '    <name>Basic Motion</name>',
    '    <effectid>basic</effectid>',
    '    <effectcategory>motion</effectcategory>',
    '    <effecttype>motion</effecttype>',
    '    <mediatype>video</mediatype>',
    '    <parameter authoringApp="PremierePro">',
    '      <parameterid>scale</parameterid>',
    '      <name>Scale</name>',
    `      <value>${decimal(scalePercent)}</value>`,
    '      <pproBypass>false</pproBypass>',
    '    </parameter>',
    '    <parameter authoringApp="PremierePro">',
    '      <parameterid>center</parameterid>',
    '      <name>Center</name>',
    '      <value><horiz>0</horiz><vert>0</vert></value>',
    '      <pproBypass>false</pproBypass>',
    '    </parameter>',
    '  </effect>',
    '</filter>',
  ].join('\n');
}

interface RetimeWindow {
  readonly frameIn: number;
  readonly frameOut: number;
  readonly clipDuration: number;
  readonly physicalIn: number;
  readonly physicalLength: number;
  readonly phase: number;
  readonly speed: number;
}

function retimeWindow(
  sourceRate: PremiereFrameRateInput,
  timelineRate: PremiereFrameRateInput,
  srcInProjectFrames: number,
  durationProjectFrames: number,
  speed: number,
): RetimeWindow {
  const physicalIn = sourceFramesAtTimelineRate(srcInProjectFrames, sourceRate, timelineRate);
  const physicalLength = Math.max(1, sourceFramesAtTimelineRate(durationProjectFrames, sourceRate, timelineRate));
  const frameIn = Math.floor(physicalIn / speed);
  const phase = physicalIn - frameIn * speed;
  const frameOut = frameIn + physicalLength;
  return { frameIn, frameOut, clipDuration: physicalLength, physicalIn, physicalLength, phase, speed };
}

function retimedFullDuration(window: RetimeWindow, mediaLength: number): number {
  return Math.max(window.frameOut, Math.ceil((mediaLength - window.phase) / window.speed));
}

function sourceLength(asset: MediaAsset | undefined, sourceRate: PremiereFrameRateInput, timelineRate: PremiereFrameRateInput): number {
  return asset?.durationInFrames
    ? Math.max(1, sourceFramesAtTimelineRate(asset.durationInFrames, sourceRate, timelineRate))
    : 0;
}

type GraphPointFlag = 'speedvirtualkf' | 'speedkfstart' | 'speedkfin' | 'speedkfout' | 'speedkfend';

interface GraphPoint {
  when: number;
  value: number;
  readonly flags: Set<GraphPointFlag>;
}

function timeRemapFilter(window: RetimeWindow, mediaLength: number, mediaType: 'video' | 'audio'): string {
  const endWhen = Math.max(window.frameOut, Math.ceil((mediaLength - window.phase) / window.speed));
  const points = new Map<number, GraphPoint>();
  const add = (when: number, value: number, ...flags: GraphPointFlag[]): void => {
    const point = points.get(when) ?? { when, value, flags: new Set() };
    point.value = value;
    for (const flag of flags) point.flags.add(flag);
    points.set(when, point);
  };
  if (window.frameIn === 0) {
    add(0, window.physicalIn, 'speedvirtualkf', 'speedkfin');
  } else {
    add(0, window.phase, 'speedvirtualkf', 'speedkfstart');
    add(window.frameIn, window.physicalIn, 'speedkfin');
  }
  add(window.frameOut, window.physicalIn + window.physicalLength * window.speed, 'speedkfout');
  if (endWhen === window.frameOut) {
    const point = points.get(endWhen)!;
    point.flags.add('speedvirtualkf');
  } else {
    add(endWhen, window.phase + endWhen * window.speed, 'speedvirtualkf', 'speedkfend');
  }
  const graph = [...points.values()].sort((a, b) => a.when - b.when).map((point) => [
    '<keyframe>',
    `  <when>${point.when}</when>`,
    `  <value>${decimal(point.value)}</value>`,
    '  <interpolation><name>FCPCurve</name></interpolation>',
    ...[...point.flags].map((flag) => `  <${flag}>TRUE</${flag}>`),
    '</keyframe>',
  ].join('\n')).join('\n');
  return [
    '<filter>',
    '  <effect>',
    '    <name>Time Remap</name>',
    '    <effectid>timeremap</effectid>',
    '    <effectcategory>motion</effectcategory>',
    '    <effecttype>motion</effecttype>',
    `    <mediatype>${mediaType}</mediatype>`,
    '    <parameter authoringApp="PremierePro"><parameterid>variablespeed</parameterid><name>Variable Speed</name><value>0</value></parameter>',
    `    <parameter authoringApp="PremierePro"><parameterid>speed</parameterid><name>Speed</name><value>${decimal(window.speed * 100)}</value></parameter>`,
    '    <parameter authoringApp="PremierePro"><parameterid>reverse</parameterid><name>Reverse</name><value>FALSE</value></parameter>',
    '    <parameter authoringApp="PremierePro"><parameterid>frameblending</parameterid><name>Frame Blending</name><value>FALSE</value></parameter>',
    '    <parameter authoringApp="PremierePro">',
    '      <parameterid>graphdict</parameterid>',
    '      <name>Graph</name>',
      graph.split('\n').map((line) => `      ${line}`).join('\n'),
    '    </parameter>',
    '  </effect>',
    '</filter>',
  ].join('\n');
}

function fileXml(resource: MediaResource, width: number, height: number): string {
  const { media } = resource;
  const details: string[] = [];
  if (media.kind !== 'audio') {
    details.push([
      '            <video>',
      '              <samplecharacteristics>',
      `                <width>${media.width ?? width}</width>`,
      `                <height>${media.height ?? height}</height>`,
      `                ${premiereRateXml(media.rate, '                ')}`,
      '              </samplecharacteristics>',
      '            </video>',
    ].join('\n'));
  }
  if (media.hasAudio) {
    details.push('            <audio><channelcount>2</channelcount></audio>');
  }
  const tc = timecodeXml(media, '          ');
  return [
    `<file id="${resource.id}">`,
    `          <name>${escapeXml(media.name)}</name>`,
    `          <pathurl>${escapeXml(media.pathurl)}</pathurl>`,
    `          ${premiereRateXml(media.rate, '          ')}`,
    `          <duration>${Math.max(1, resource.durationFrames)}</duration>`,
    ...(tc ? [tc] : []),
    '          <media>',
    ...details,
    '          </media>',
    '        </file>',
  ].join('\n');
}

function clipXml(
  clip: ClipRecord,
  definedFiles: Set<string>,
  clipIndexes: ReadonlyMap<string, number>,
  width: number,
  height: number,
): string {
  const firstReference = !definedFiles.has(clip.media.media.key);
  if (firstReference) definedFiles.add(clip.media.media.key);
  const file = firstReference
    ? fileXml(clip.media, width, height)
    : `<file id="${clip.media.id}"/>`;
  const peer = clip.peer;
  const links = [
    { id: clip.id, mediaType: clip.mediaType, trackIndex: clip.trackIndex },
    ...(peer ? [peer] : []),
  ].map((linked) => [
    '            <link>',
    `              <linkclipref>${linked.id}</linkclipref>`,
    `              <mediatype>${linked.mediaType}</mediatype>`,
    `              <trackindex>${linked.trackIndex}</trackindex>`,
    `              <clipindex>${clipIndexes.get(linked.id) ?? 1}</clipindex>`,
    '            </link>',
  ].join('\n'));
  const rateXml = premiereRateXml(clip.rate, '            ');
  return [
    `          <clipitem id="${clip.id}">`,
    `            <name>${escapeXml(clip.item.name)}</name>`,
    `            <duration>${clip.clipDuration}</duration>`,
    `            ${rateXml}`,
    `            <in>${clip.inFrame}</in>`,
    `            <out>${clip.outFrame}</out>`,
    `            <start>${clip.start}</start>`,
    `            <end>${clip.start + clip.duration}</end>`,
    '            <enabled>TRUE</enabled>',
    `            <sourcetrack><mediatype>${clip.mediaType}</mediatype><trackindex>1</trackindex></sourcetrack>`,
    `            ${file}`,
    ...links,
    ...(clip.filters ? clip.filters.split('\n').map((line) => `            ${line}`) : []),
    '          </clipitem>',
  ].join('\n');
}

/** Convert one flat editor timeline to a Final Cut 7 XML document for Premiere import. */
export function timelineToPremiereXml(
  state: TimelineState,
  opts: PremiereXmlExportOptions = {},
): string {
  assertState(state);
  requireBakes(state, opts);
  // Ensures the sequence rate is one of the exact rational rates XMEML can encode.
  premiereFrameRate(state.fps);
  const title = escapeXml((opts.title ?? '').trim() || 'OpenChatCut Timeline');
  const totalFrames = timelineDuration(state);
  const trackIds = timelineTrackIds(state);
  const videoIds = trackIds.filter((id) => trackKind(state, id) === 'video');
  const audioIds = trackIds.filter((id) => trackKind(state, id) === 'audio');
  const videoOrder = [...videoIds].reverse(); // bottom editor row becomes Premiere V1
  const videoTrackIndex = new Map(videoOrder.map((id, index) => [id, index + 1]));
  const audioTrackIndex = new Map(audioIds.map((id, index) => [id, index + 1]));
  const companionTrackIndex = new Map(videoOrder.map((id, index) => [id, audioIds.length + index + 1]));
  const videoTracks = new Map<number, ClipRecord[]>();
  const audioTracks = new Map<number, ClipRecord[]>();
  const resources = new Map<string, MediaResource>();
  let nextFileId = 1;
  let nextVideoClipId = 1;
  let nextAudioClipId = 1;

  const register = (media: ResolvedMedia, requiredEnd: number, asset?: MediaAsset): MediaResource => {
    const endFrame = Math.max(requiredEnd, sourceLength(asset, media.rate, state.fps), 1);
    const existing = resources.get(media.key);
    if (existing) {
      existing.durationFrames = Math.max(existing.durationFrames, endFrame);
      if (existing.media.kind === 'audio' && media.kind === 'video') existing.media = media;
      return existing;
    }
    const resource: MediaResource = {
      id: `file-${nextFileId++}`,
      media,
      durationFrames: Math.max(1, endFrame),
    };
    resources.set(media.key, resource);
    return resource;
  };
  const addClip = (target: Map<number, ClipRecord[]>, clip: ClipRecord): void => {
    const clips = target.get(clip.trackIndex) ?? [];
    clips.push(clip);
    target.set(clip.trackIndex, clips);
  };

  const orderedItems = [...state.items].sort((a, b) => (
    a.startFrame - b.startFrame || trackIds.indexOf(a.track) - trackIds.indexOf(b.track) || a.id.localeCompare(b.id)
  ));
  for (const item of orderedItems) {
    const baked = bakedFor(item, opts);
    const asset = assetFor(state, item);
    const visualSrc = baked?.visualSrc ?? (item.kind === 'audio' ? undefined : item.src);
    const audioSrc = baked?.audioSrc ?? (item.kind === 'audio' || item.kind === 'video' ? item.src : undefined);
    let videoClip: ClipRecord | undefined;
    if (visualSrc) {
      const isVisualBake = !!baked?.visualSrc;
      const visualKind = isVisualBake ? 'video' : item.kind;
      const source = mediaFor(state, item, visualSrc, visualKind, opts, isVisualBake ? undefined : asset, isVisualBake);
      const speed = !isVisualBake && item.kind === 'video' ? item.playbackRate ?? 1 : 1;
      const srcIn = isVisualBake ? 0 : item.srcInFrame ?? 0;
      const window = retimeWindow(source.rate, state.fps, srcIn, item.durationInFrames, speed);
      const requiredEnd = Math.ceil(window.physicalIn + window.physicalLength * speed);
      const resource = register(source, requiredEnd, isVisualBake ? undefined : asset);
      const trackIndex = videoTrackIndex.get(item.track);
      if (!trackIndex) throw new Error(`Premiere XML visual item ${item.id} is on non-video track ${item.track}`);
      const fitWidth = source.width ?? item.width;
      const fitHeight = source.height ?? item.height;
      const fitScale = fitWidth && fitHeight
        ? (state.fit === 'cover'
          ? Math.max(state.width / fitWidth, state.height / fitHeight)
          : Math.min(state.width / fitWidth, state.height / fitHeight)) * 100
        : 100;
      const autoFit = !isVisualBake && fitWidth && fitHeight && Math.abs(fitScale - 100) > 1e-6
        ? basicMotionScaleFilter(fitScale)
        : '';
      videoClip = {
        id: `clip-v-${String(nextVideoClipId++).padStart(6, '0')}`,
        item, media: resource, start: item.startFrame, duration: item.durationInFrames,
        clipDuration: speed === 1 ? window.clipDuration : retimedFullDuration(window, resource.durationFrames),
        inFrame: window.frameIn, outFrame: window.frameOut, rate: source.rate,
        trackIndex, mediaType: 'video', filters: autoFit || undefined,
        ...(speed !== 1 ? { retime: { window, mediaType: 'video' as const } } : {}),
      };
      addClip(videoTracks, videoClip);
    }

    if (audioSrc) {
      const isAudioBake = !!baked?.audioSrc;
      const audioKind = isAudioBake ? 'audio' : item.kind;
      const source = mediaFor(state, item, audioSrc, audioKind, opts, isAudioBake ? undefined : asset, isAudioBake);
      const resource = register(source, Math.max(item.srcInFrame ?? 0, item.durationInFrames, 1), isAudioBake ? undefined : asset);
      const trackIndex = item.kind === 'video'
        ? companionTrackIndex.get(item.track)
        : audioTrackIndex.get(item.track);
      if (!trackIndex) throw new Error(`Premiere XML audio item ${item.id} is on an incompatible track ${item.track}`);
      const transcript = !isAudioBake && item.kind === 'audio' ? transcriptSegments(item, state.fps) : null;
      const segments = isAudioBake || item.kind !== 'audio'
        ? [{ fromFrame: item.startFrame, durFrames: item.durationInFrames, srcStartFrame: isAudioBake ? 0 : item.srcInFrame ?? 0 }]
        : transcript?.map((segment) => ({
          fromFrame: segment.fromFrame,
          durFrames: segment.durFrames,
          srcStartFrame: segment.srcStartFrame,
        })) ?? [{ fromFrame: item.startFrame, durFrames: item.durationInFrames, srcStartFrame: item.srcInFrame ?? 0 }];
      const createdAudioClips: ClipRecord[] = [];
      for (const segment of segments) {
        if (segment.durFrames <= 0) continue;
        const speed = isAudioBake || transcript ? 1 : item.playbackRate ?? 1;
        const sourceStart = isAudioBake ? 0 : segment.srcStartFrame;
        const window = retimeWindow(source.rate, state.fps, sourceStart, segment.durFrames, speed);
        const requiredEnd = Math.ceil(window.physicalIn + window.physicalLength * speed);
        resource.durationFrames = Math.max(resource.durationFrames, requiredEnd);
        const audioLevels = isAudioBake ? '' : audioLevelsFilter(
          item, source.rate, state.fps, window.frameIn, segment.fromFrame, segment.durFrames,
        );
        const clip: ClipRecord = {
          id: `clip-a-${String(nextAudioClipId++).padStart(6, '0')}`,
          item, media: resource, start: segment.fromFrame, duration: segment.durFrames,
          clipDuration: speed === 1 ? window.clipDuration : retimedFullDuration(window, resource.durationFrames),
          inFrame: window.frameIn, outFrame: window.frameOut, rate: source.rate,
          trackIndex, mediaType: 'audio',
          filters: audioLevels || undefined,
          ...(speed !== 1 ? { retime: { window, mediaType: 'audio' as const } } : {}),
        };
        createdAudioClips.push(clip);
        addClip(audioTracks, clip);
      }
      // Source video audio and picture remain separately editable but linked.
      if (videoClip && createdAudioClips.length === 1) {
        const audioClip = createdAudioClips[0]!;
        videoClip.peer = { id: audioClip.id, mediaType: 'audio', trackIndex: audioClip.trackIndex };
        audioClip.peer = { id: videoClip.id, mediaType: 'video', trackIndex: videoClip.trackIndex };
      }
    }
  }

  // A file can be referenced by several clips with different trims/speeds.
  // Finalize clip duration and time-remap graph only after every use has had a
  // chance to extend the shared resource's known full source duration.
  for (const tracks of [videoTracks, audioTracks]) {
    for (const clips of tracks.values()) {
      for (const clip of clips) {
        if (clip.retime) {
          clip.clipDuration = retimedFullDuration(clip.retime.window, clip.media.durationFrames);
          const filter = timeRemapFilter(clip.retime.window, clip.media.durationFrames, clip.retime.mediaType);
          clip.filters = [clip.filters, filter].filter(Boolean).join('\n') || undefined;
        } else {
          clip.clipDuration = clip.media.durationFrames;
        }
      }
    }
  }

  const sortTracks = (tracks: Map<number, ClipRecord[]>): void => {
    for (const clips of tracks.values()) {
      clips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      clips.forEach((clip, index) => { clip.clipIndex = index + 1; });
    }
  };
  sortTracks(videoTracks);
  sortTracks(audioTracks);
  const clipIndexes = new Map<string, number>();
  for (const clips of [...videoTracks.values(), ...audioTracks.values()]) {
    for (const clip of clips) clipIndexes.set(clip.id, clip.clipIndex ?? 1);
  }
  const definedFiles = new Set<string>();
  const renderTracks = (
    tracks: Map<number, ClipRecord[]>,
    ids: readonly string[],
    isVideo: boolean,
  ): string => ids.map((id, index) => {
    const trackIndex = index + 1;
    const clips = tracks.get(trackIndex) ?? [];
    const disabled = isVideo
      ? state.tracks?.[id]?.hidden === true
      : state.tracks?.[id]?.hidden === true || state.tracks?.[id]?.muted === true;
    return [
      '        <track>',
      ...clips.map((clip) => clipXml(clip, definedFiles, clipIndexes, state.width, state.height)),
      `          <enabled>${disabled ? 'FALSE' : 'TRUE'}</enabled>`,
      '          <locked>FALSE</locked>',
      '        </track>',
    ].join('\n');
  }).join('\n');
  const videoTrackXml = renderTracks(videoTracks, videoOrder, true);
  const audioOrder = [
    ...audioIds,
    ...videoOrder,
  ];
  const audioTrackXml = audioOrder.map((id, index) => {
    const trackIndex = index + 1;
    const clips = audioTracks.get(trackIndex) ?? [];
    const companion = index >= audioIds.length;
    const sourceTrackId = companion ? videoOrder[index - audioIds.length]! : id;
    const disabled = state.tracks?.[sourceTrackId]?.hidden === true
      || state.tracks?.[sourceTrackId]?.muted === true;
    return [
      '        <track>',
      ...clips.map((clip) => clipXml(clip, definedFiles, clipIndexes, state.width, state.height)),
      `          <enabled>${disabled ? 'FALSE' : 'TRUE'}</enabled>`,
      '          <locked>FALSE</locked>',
      '        </track>',
    ].join('\n');
  }).join('\n');
  const sequenceTc = [
    '<timecode>',
    `  ${premiereRateXml(state.fps, '    ')}`,
    '  <string>00:00:00:00</string>',
    '  <frame>0</frame>',
    '  <displayformat>NDF</displayformat>',
    '</timecode>',
  ].join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="5">',
    '  <project>',
    `    <name>${title}</name>`,
    '    <children>',
    '      <sequence id="sequence-1">',
    `        <name>${title}</name>`,
    `        <duration>${totalFrames}</duration>`,
    `        ${premiereRateXml(state.fps, '        ')}`,
    `        ${sequenceTc}`,
    '        <media>',
    '          <video>',
    '            <format>',
    '              <samplecharacteristics>',
    `                <width>${state.width}</width>`,
    `                <height>${state.height}</height>`,
    `                ${premiereRateXml(state.fps, '                ')}`,
    '              </samplecharacteristics>',
    '            </format>',
    videoTrackXml,
    '          </video>',
    '          <audio>',
    `            <numOutputChannels>${Math.max(2, audioOrder.length)}</numOutputChannels>`,
    audioTrackXml,
    '          </audio>',
    '        </media>',
    '      </sequence>',
    '    </children>',
    '  </project>',
    '</xmeml>',
  ].join('\n');
}
