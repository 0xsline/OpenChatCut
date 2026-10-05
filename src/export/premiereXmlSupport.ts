import { clipFadeFactor } from '../editor/clipFade';
import { sampleKeyframes } from '../editor/keyframes';
import type { MediaAsset, TimelineItem } from '../editor/types';
import type { ExportMediaStart } from '../../shared/export-media-sources';
import { stripInvalidXml10Characters } from '../media/sourceFilename';
import {
  frameCountToTimecode,
  mediaStartFrame,
  premiereRateXml,
  sourceFramesAtTimelineRate,
  type PremiereFrameRateInput,
} from './premiereXmlTime';
export function escapeXml(value: unknown): string {
  return stripInvalidXml10Characters(String(value ?? ''))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface ResolvedMedia {
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

export interface MediaResource {
  readonly id: string;
  media: ResolvedMedia;
  durationFrames: number;
}

export interface ClipRecord {
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

export function audioLevelsFilter(
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

export function basicMotionScaleFilter(scalePercent: number): string {
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

export interface RetimeWindow {
  readonly frameIn: number;
  readonly frameOut: number;
  readonly clipDuration: number;
  readonly physicalIn: number;
  readonly physicalLength: number;
  readonly phase: number;
  readonly speed: number;
}

export function retimeWindow(
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

export function retimedFullDuration(window: RetimeWindow, mediaLength: number): number {
  return Math.max(window.frameOut, Math.ceil((mediaLength - window.phase) / window.speed));
}

export function sourceLength(asset: MediaAsset | undefined, sourceRate: PremiereFrameRateInput, timelineRate: PremiereFrameRateInput): number {
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

export function timeRemapFilter(window: RetimeWindow, mediaLength: number, mediaType: 'video' | 'audio'): string {
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

export function clipXml(
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

