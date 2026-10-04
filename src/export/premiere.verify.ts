// Runnable check: `npx tsx src/export/premiere.verify.ts`.
// Semantic XMEML checks for track layout, frame clocks, media identity and
// escaped paths. Premiere itself is not part of this verification.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DOMParser, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { ExportMediaSourceMap } from '../../shared/export-media-sources';
import { planPremiereExport } from './premiereBakePlan';
import { timelineToPremiereXml } from './premiereXml';

function elementChildren(parent: XmlElement): XmlElement[] {
  return Array.from(parent.childNodes)
    .filter((node: XmlNode) => node.nodeType === 1)
    .map((node) => node as XmlElement);
}

function children(parent: XmlElement, tag: string): XmlElement[] {
  return elementChildren(parent).filter((element) => element.tagName === tag);
}

function child(parent: XmlElement, tag: string): XmlElement {
  const matches = children(parent, tag);
  assert.equal(matches.length, 1, `<${parent.tagName}> has one direct <${tag}>`);
  return matches[0]!;
}

function text(parent: XmlElement, tag: string): string {
  return child(parent, tag).textContent ?? '';
}

function parse(xml: string): XmlDocument {
  const errors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => errors.push(`${level}: ${message}`),
  }).parseFromString(xml, 'application/xml');
  assert.deepEqual(errors, [], 'serializer emits well-formed XML');
  assert.equal(document.documentElement?.tagName, 'xmeml', 'XMEML document root');
  assert.equal(document.documentElement?.getAttribute('version'), '5', 'XMEML version 5');
  return document;
}

function state(items: TimelineItem[], extra: Partial<TimelineState> = {}): TimelineState {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items,
    ...extra,
  };
}

function exportXml(
  timeline: TimelineState,
  options: { title?: string; mediaDir?: string; mediaSources?: ExportMediaSourceMap; bakedMedia?: Record<string, { visualSrc?: string; audioSrc?: string }> } = {},
): string {
  const defaultSources: Record<string, { pathRate: { numerator: number; denominator: number }; originalRate: { numerator: number; denominator: number } }> = {};
  for (const item of timeline.items) {
    if (item.kind === 'video' && item.src) {
      defaultSources[item.src] = {
        pathRate: { numerator: 30, denominator: 1 },
        originalRate: { numerator: 30, denominator: 1 },
      };
    }
  }
  return timelineToPremiereXml(timeline, {
    ...options,
    mediaSources: { ...defaultSources, ...options.mediaSources } as unknown as ExportMediaSourceMap,
  });
}

function clip(
  id: string,
  track: string,
  kind: TimelineItem['kind'],
  startFrame: number,
  durationInFrames: number,
  extra: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    id,
    track,
    kind,
    startFrame,
    durationInFrames,
    name: id,
    src: `/media/uploads/${id}.mov`,
    ...extra,
  };
}

function sequence(document: XmlDocument): XmlElement {
  const sequences = Array.from(document.getElementsByTagName('sequence'));
  assert.equal(sequences.length, 1, 'one sequence is exported');
  return sequences[0]!;
}

function mediaTracks(sequenceElement: XmlElement, type: 'video' | 'audio'): XmlElement[] {
  const media = child(sequenceElement, 'media');
  const group = child(media, type);
  return children(group, 'track');
}

function clipItems(track: XmlElement): XmlElement[] {
  return children(track, 'clipitem');
}

function frameRate(node: XmlElement): [string, string] {
  const rate = child(node, 'rate');
  return [text(rate, 'timebase'), text(rate, 'ntsc')];
}

interface ClipLocation {
  readonly clip: XmlElement;
  readonly mediaType: 'video' | 'audio';
  readonly trackIndex: number;
  readonly clipIndex: number;
}

function clipLocations(sequenceElement: XmlElement): ClipLocation[] {
  const media = child(sequenceElement, 'media');
  return (['video', 'audio'] as const).flatMap((mediaType) => (
    children(child(media, mediaType), 'track').flatMap((track, trackIndex) => (
      clipItems(track).map((clip, clipIndex) => ({
        clip,
        mediaType,
        trackIndex: trackIndex + 1,
        clipIndex: clipIndex + 1,
      }))
    ))
  ));
}

function effectFor(clip: XmlElement, effectId: string, mediatype?: string): XmlElement {
  const found = Array.from(clip.getElementsByTagName('effect')).find((effect) => (
    text(effect, 'effectid') === effectId
    && (mediatype === undefined || text(effect, 'mediatype') === mediatype)
  ));
  assert.ok(found, `${clipName(clip)} contains the ${effectId} ${mediatype ?? ''} effect`);
  return found;
}

function effectParameter(effect: XmlElement, parameterId: string): XmlElement {
  const found = Array.from(effect.getElementsByTagName('parameter')).find((parameter) => (
    text(parameter, 'parameterid') === parameterId
  ));
  assert.ok(found, `${text(effect, 'effectid')} has parameter ${parameterId}`);
  return found;
}

function effectKeyframes(parameter: XmlElement): Array<{ when: string; value: string; flags: string[] }> {
  return children(parameter, 'keyframe').map((keyframe) => ({
    when: text(keyframe, 'when'),
    value: text(keyframe, 'value'),
    flags: elementChildren(keyframe).filter((element) => element.tagName.startsWith('speed'))
      .filter((element) => text(keyframe, element.tagName) === 'TRUE')
      .map((element) => element.tagName),
  }));
}

function clipName(item: XmlElement): string {
  return text(item, 'name');
}

function clipFile(item: XmlElement): XmlElement {
  return child(item, 'file');
}

function resourceId(file: XmlElement): string {
  const id = file.getAttribute('id');
  assert.ok(id, 'media file has an identity');
  return id;
}

function fileId(item: XmlElement): string {
  const id = resourceId(clipFile(item));
  assert.ok(id, `${clipName(item)} references a media file id`);
  return id;
}

function sameFileUrl(actual: string, expected: string): boolean {
  const left = new URL(actual);
  const right = new URL(expected);
  return left.protocol === right.protocol && left.host === right.host
    && decodeURIComponent(left.pathname) === decodeURIComponent(right.pathname)
    && left.search === right.search && left.hash === right.hash;
}

function fullFileByPath(document: XmlDocument, href: string): XmlElement {
  const files = Array.from(document.getElementsByTagName('file'));
  const found = files.find((file) => children(file, 'pathurl').length > 0
    && sameFileUrl(text(file, 'pathurl'), href));
  assert.ok(found, `media file definition exists for ${href}`);
  return found;
}

function timecodeFor(file: XmlElement): XmlElement {
  return child(file, 'timecode');
}

const video = (id: string, start: number, duration: number, extra: Partial<TimelineItem> = {}) => (
  clip(id, 'V1', 'video', start, duration, extra)
);

// ── Track order, independent placements, repeated media identity and A/V links ──
{
  const camera = video('camera-first', 30, 60, {
    name: 'Intro & <camera>',
    src: '/media/uploads/camera.mov',
    sourceFilename: 'Camera #1.mov',
    originalFilePath: 'C:\\Media\\A & B\\Camera #1.mov',
    srcInFrame: 60,
  });
  const repeated = video('camera-second', 150, 30, {
    name: 'Second use',
    src: camera.src,
    sourceFilename: camera.sourceFilename,
    originalFilePath: camera.originalFilePath,
    srcInFrame: 150,
  });
  const upper = clip('overlay', 'V2', 'video', 60, 30, {
    name: 'Upper layer',
    src: 'file:///C:/Media/a%20b%20%231%20&%20tag.mov',
  });
  const music = clip('music', 'A1', 'audio', 0, 180, { name: 'Music' });
  const lowerAudio = clip('lower-audio', 'A2', 'audio', 90, 45, { name: 'Lower audio' });
  const timeline = state([camera, repeated, upper, music, lowerAudio], {
    trackOrder: ['V2', 'V1', 'A1', 'A2'],
    tracks: {
      V2: { kind: 'video' }, V1: { kind: 'video' },
      A1: { kind: 'audio' }, A2: { kind: 'audio' },
    },
  });
  const xml = exportXml(timeline, { title: 'Edit & <cut>' });
  const doc = parse(xml);
  const seq = sequence(doc);
  assert.equal(text(seq, 'name'), 'Edit & <cut>', 'sequence title round-trips through XML escaping');

  const videoLanes = mediaTracks(seq, 'video');
  const audioLanes = mediaTracks(seq, 'audio');
  assert.equal(videoLanes.length, 2, 'video tracks remain separate');
  assert.ok(audioLanes.length >= 2, 'audio source lanes remain separate alongside any linked embedded-audio lanes');
  assert.deepEqual(clipItems(videoLanes[0]!).map(clipName), ['Intro & <camera>', 'Second use'],
    'V1 is the first exported video lane and items retain timeline order');
  assert.deepEqual(clipItems(videoLanes[1]!).map(clipName), ['Upper layer'],
    'V2 follows V1 in visual track order');
  const musicLane = audioLanes.findIndex((lane) => clipItems(lane).some((item) => clipName(item) === 'Music'));
  const lowerAudioLane = audioLanes.findIndex((lane) => clipItems(lane).some((item) => clipName(item) === 'Lower audio'));
  assert.ok(musicLane >= 0 && lowerAudioLane > musicLane, 'A1 precedes A2 even when linked embedded audio lanes are present');

  const cameraClips = clipItems(videoLanes[0]!);
  assert.deepEqual(cameraClips.map((item) => [text(item, 'start'), text(item, 'end'), text(item, 'in'), text(item, 'out')]),
    [['30', '90', '60', '120'], ['150', '180', '150', '180']],
    'timeline placements and source windows use right-open frame bounds');
  assert.equal(fileId(cameraClips[0]!), fileId(cameraClips[1]!),
    'repeated use of one source references the same XMEML file identity');
  const cameraHref = pathToFileURL('C:\\Media\\A & B\\Camera #1.mov').href;
  const cameraFile = fullFileByPath(doc, cameraHref);
  assert.equal(children(cameraFile, 'pathurl').length, 1, 'one full media definition owns the source URL');
  assert.equal(cameraFile.getAttribute('id'), fileId(cameraClips[0]!));
  assert.match(text(cameraFile, 'pathurl'), /A%20%26%20B/, 'ampersands and spaces are URL-escaped in original paths');

  const escapedUrl = 'file:///C:/Media/a%20b%20%231%20&%20tag.mov';
  const urlFile = fullFileByPath(doc, escapedUrl);
  assert.ok(sameFileUrl(text(urlFile, 'pathurl'), escapedUrl),
    'local file URLs containing ampersands survive XML escaping as one path');

  const allClips = [...videoLanes, ...audioLanes].flatMap(clipItems);
  const clipIds = new Set(allClips.map((item) => item.getAttribute('id')).filter((id): id is string => !!id));
  assert.equal(clipIds.size, allClips.length, 'each clipitem has a distinct stable link target id');
  const linked = allClips.filter((item) => children(item, 'link').length > 0);
  assert.ok(linked.some((item) => children(item, 'link').some((link) => text(link, 'mediatype') === 'audio')),
    'video clipitems declare their linked audio companion');
  assert.ok(linked.some((item) => children(item, 'link').some((link) => text(link, 'mediatype') === 'video')),
    'audio clipitems point back to their linked video');
  for (const item of linked) {
    for (const link of children(item, 'link')) {
      assert.ok(clipIds.has(text(link, 'linkclipref')), 'linkclipref resolves to an exported clipitem');
      assert.ok(Number.isInteger(Number(text(link, 'trackindex')))
        && Number(text(link, 'trackindex')) >= 0, 'linked lane index is a nonnegative integer');
      assert.ok(Number(text(link, 'clipindex')) >= 0, 'linked clip index is nonnegative');
    }
  }
  const locations = clipLocations(seq);
  const locationById = new Map(locations.map((location) => [location.clip.getAttribute('id'), location]));
  for (const location of locations) {
    const ownId = location.clip.getAttribute('id')!;
    for (const link of children(location.clip, 'link')) {
      const linkedLocation = locationById.get(text(link, 'linkclipref'));
      assert.ok(linkedLocation, `${ownId}: link points to a real clip in its peer lane`);
      assert.equal(text(link, 'mediatype'), linkedLocation.mediaType, `${ownId}: link type names its peer media`);
      assert.equal(Number(text(link, 'trackindex')), linkedLocation.trackIndex, `${ownId}: link lane index resolves to the peer lane`);
      assert.equal(Number(text(link, 'clipindex')), linkedLocation.clipIndex, `${ownId}: link clip index resolves to the peer clip`);
      assert.ok(children(linkedLocation.clip, 'link').some((back) => text(back, 'linkclipref') === ownId),
        `${ownId}: AV companion links are reciprocal`);
    }
  }

  const fileElements = Array.from(doc.getElementsByTagName('file'));
  const fullFileDefinitions = fileElements.filter((file) => children(file, 'pathurl').length === 1);
  const fullDefinitionsById = new Map<string, XmlElement[]>();
  for (const file of fullFileDefinitions) {
    const id = resourceId(file);
    const definitions = fullDefinitionsById.get(id) ?? [];
    definitions.push(file);
    fullDefinitionsById.set(id, definitions);
    assert.equal(file.parentNode?.nodeName, 'clipitem', `${id}: a full file definition is scoped to its first clip reference`);
  }
  assert.equal([...fullDefinitionsById.values()].some((definitions) => definitions.length !== 1), false,
    'every media identity has exactly one full file definition');
  for (const file of fileElements) {
    const id = resourceId(file);
    assert.ok(fullDefinitionsById.has(id), `${id}: every clip file reference resolves to a full definition`);
    assert.equal(file.parentNode?.nodeName, 'clipitem', `${id}: file refs are not emitted in invalid project-level locations`);
  }
}

// ── Original and working media have independent rates and source clocks ──
{
  const src = '/media/uploads/mixed-rate.mov';
  const item = video('mixed-rate', 10, 30, {
    src,
    originalFilePath: undefined,
    srcInFrame: 60,
  });
  const originalStart = { value: 900_000, timescale: 25, timecode: '10:00:00:00', dropFrame: false };
  const pathStart = { value: 1_188_000, timescale: 30, timecode: '11:00:00:00', dropFrame: false };
  const mediaSources = {
    [src]: {
      path: 'D:\\Cache\\proxy.mov',
      originalPath: 'D:\\Camera Originals\\master.mov',
      pathRate: { numerator: 30, denominator: 1 },
      originalRate: { numerator: 25, denominator: 1 },
      pathStart,
      originalStart,
    },
  } as unknown as ExportMediaSourceMap;
  const doc = parse(exportXml(state([item]), { mediaSources }));
  const lane = mediaTracks(sequence(doc), 'video')[0]!;
  const emitted = clipItems(lane)[0]!;
  assert.deepEqual([text(emitted, 'start'), text(emitted, 'end'), text(emitted, 'in'), text(emitted, 'out')],
    ['10', '40', '50', '75'],
    '30 project frames and a project-frame in-point convert to a 25 fps original source window');
  assert.deepEqual(frameRate(emitted), ['25', 'FALSE'],
    'a clip runs on its native 25 fps source clock while placement stays in 30 fps project frames');
  const audioPeer = mediaTracks(sequence(doc), 'audio').flatMap(clipItems)
    .find((candidate) => clipName(candidate) === clipName(emitted));
  assert.ok(audioPeer, 'native linked camera audio is retained');
  assert.deepEqual(frameRate(audioPeer), ['25', 'FALSE'], 'linked native audio follows the same measured file clock');
  assert.deepEqual(frameRate(sequence(doc)), ['30', 'FALSE'], 'the sequence retains the 30 fps project clock');
  const originalHref = pathToFileURL('D:\\Camera Originals\\master.mov').href;
  const mediaFile = fullFileByPath(doc, originalHref);
  assert.equal(text(child(mediaFile, 'rate'), 'timebase'), '25', 'original rate wins over working-copy rate');
  assert.equal(text(timecodeFor(mediaFile), 'string'), '10:00:00:00', 'original clock is used even when the working copy has another start');
  assert.equal(text(timecodeFor(mediaFile), 'frame'), '900000', 'embedded clock origin remains separate from clip-relative in/out');
  assert.equal(Array.from(doc.getElementsByTagName('pathurl')).some((path) => path.textContent === pathToFileURL('D:\\Cache\\proxy.mov').href), false,
    'the different-clock working copy is not offered as a relinkable proxy');
}

// ── Source rates/timecodes: NDF integer rates and both 29.97 timecode modes ──
{
  const cases = [
    { id: 'source-24', rate: { numerator: 24, denominator: 1 }, nominal: '24', ntsc: 'FALSE', start: { value: 86_400, timescale: 24, timecode: '01:00:00:00', dropFrame: false } },
    { id: 'source-25', rate: { numerator: 25, denominator: 1 }, nominal: '25', ntsc: 'FALSE', start: { value: 90_000, timescale: 25, timecode: '01:00:00:00', dropFrame: false } },
    { id: 'source-30', rate: { numerator: 30, denominator: 1 }, nominal: '30', ntsc: 'FALSE', start: { value: 108_000, timescale: 30, timecode: '01:00:00:00', dropFrame: false } },
    { id: 'source-2997-ndf', rate: { numerator: 30_000, denominator: 1_001 }, nominal: '30', ntsc: 'TRUE', start: { value: 108_108_000, timescale: 30_000, timecode: '01:00:00:00', dropFrame: false } },
    { id: 'source-2997-df', rate: { numerator: 30_000, denominator: 1_001 }, nominal: '30', ntsc: 'TRUE', start: { value: 107_999_892, timescale: 30_000, timecode: '01:00:00;00', dropFrame: true } },
  ] as const;
  const items = cases.map(({ id }, index) => video(id, index * 30, 30, { src: `/media/uploads/${id}.mov` }));
  const mediaSources = Object.fromEntries(cases.map(({ id, rate, start }) => [
    `/media/uploads/${id}.mov`, {
      path: `C:\\Sources\\${id}.mov`,
      originalPath: `C:\\Sources\\${id}.mov`,
      pathRate: rate,
      originalRate: rate,
      pathStart: start,
      originalStart: start,
    },
  ])) as unknown as ExportMediaSourceMap;
  const doc = parse(exportXml(state(items), { mediaSources }));
  for (const { id, nominal, ntsc, start } of cases) {
    const href = pathToFileURL(`C:\\Sources\\${id}.mov`).href;
    const file = fullFileByPath(doc, href);
    const rate = child(file, 'rate');
    assert.deepEqual([text(rate, 'timebase'), text(rate, 'ntsc')], [nominal, ntsc], `${id}: file rate uses measured source rate`);
    const tc = timecodeFor(file);
    assert.equal(text(tc, 'string'), start.timecode, `${id}: embedded label is preserved`);
    assert.equal(text(tc, 'displayformat'), start.dropFrame ? 'DF' : 'NDF', `${id}: drop-frame mode is preserved`);
    const expectedFrame = Math.round((start.value / start.timescale)
      * (cases.find((candidate) => candidate.id === id)!.rate.numerator
        / cases.find((candidate) => candidate.id === id)!.rate.denominator));
    assert.equal(Number(text(tc, 'frame')), expectedFrame, `${id}: physical source frame is derived from seconds and source rate`);
    const pictureClip = clipItems(mediaTracks(sequence(doc), 'video')[0]!).find((candidate) => clipName(candidate) === id)!;
    assert.deepEqual(frameRate(pictureClip), [nominal, ntsc], `${id}: clip rate follows the measured source clock`);
  }
}

// ── Transcript-kept audio becomes right-open source ranges, with deleted words absent ──
{
  const src = '/media/uploads/voice.wav';
  const transcript = [
    { text: 'hello', start: 0, end: 1000 },
    { text: 'um', start: 1000, end: 3000 },
    { text: 'world', start: 3000, end: 4000 },
  ];
  const voice = clip('voice', 'A1', 'audio', 0, 60, {
    src,
    transcript,
    deletedWordIdx: [1],
  });
  const doc = parse(exportXml(state([voice])));
  const exported = clipItems(mediaTracks(sequence(doc), 'audio')[0]!);
  assert.equal(exported.length, 2, 'deleted transcript word splits audio into the two retained runs');
  assert.deepEqual(exported.map((item) => [text(item, 'start'), text(item, 'end'), text(item, 'in'), text(item, 'out')]),
    [['0', '30', '0', '30'], ['30', '60', '90', '120']],
    'kept source ranges are packed consecutively on the timeline while preserving the original source gap');
  assert.equal(new Set(exported.map(fileId)).size, 1, 'transcript segments share one source file identity');
}

// ── Baked visual is selective, begins at source frame zero and keeps native audio ──
{
  const camera = video('baked-camera', 40, 20, {
    src: '/media/uploads/baked-camera.mov',
    srcInFrame: 300,
    volume: 0.5,
    effects: [{ id: 'fx', assetId: 'builtin:fx-test' }],
  });
  const title = clip('title-card', 'V2', 'motion-graphic', 60, 45, {
    name: 'Title card',
    src: undefined,
    code: 'return null;',
  });
  const ordinary = video('ordinary-camera', 105, 30, { src: '/media/uploads/ordinary-camera.mov' });
  const bakedMedia = {
    'baked-camera': { visualSrc: 'C:\\Renders\\baked visual.mov' },
    'title-card': { visualSrc: 'C:\\Renders\\title.mov' },
  };
  const doc = parse(exportXml(state([camera, title, ordinary]), { bakedMedia, mediaDir: 'C:\\Media' }));
  const seq = sequence(doc);
  const videoLanes = mediaTracks(seq, 'video');
  const baseLane = videoLanes[0]!;
  const bakedVideo = clipItems(baseLane).find((item) => clipName(item) === 'baked-camera');
  const bakedTitle = clipItems(videoLanes[1]!).find((item) => clipName(item) === 'Title card');
  const untouched = clipItems(baseLane).find((item) => clipName(item) === 'ordinary-camera');
  assert.ok(bakedVideo && bakedTitle && untouched, 'selected items are baked while an unselected item stays on its original source');
  assert.deepEqual([text(bakedVideo, 'start'), text(bakedVideo, 'end'), text(bakedVideo, 'in'), text(bakedVideo, 'out')],
    ['40', '60', '0', '20'], 'baked visual uses an untrimmed, normal-rate output span');
  assert.equal(text(fullFileByPath(doc, pathToFileURL('C:\\Renders\\baked visual.mov').href), 'name'), 'baked visual.mov');
  assert.equal(text(fullFileByPath(doc, pathToFileURL('C:\\Renders\\title.mov').href), 'name'), 'title.mov');
  const originalAudio = mediaTracks(seq, 'audio').flatMap(clipItems)
    .find((item) => clipName(item) === 'baked-camera');
  assert.ok(originalAudio, 'baking only the picture retains the source audio clip');
  assert.deepEqual([text(originalAudio, 'in'), text(originalAudio, 'out')], ['300', '320'],
    'visual-only baking retains the native source audio trim');
  assert.deepEqual(frameRate(originalAudio), ['30', 'FALSE'], 'visual-only baking retains the native source audio rate');
  const cameraGain = effectParameter(effectFor(originalAudio, 'audiolevels', 'audio'), 'level');
  assert.equal(text(cameraGain, 'value'), '0.5', 'visual-only baking retains the native source audio gain');
  const bakedVideoItem = clipItems(baseLane).find((item) => clipName(item) === 'baked-camera')!;
  assert.equal(fileId(originalAudio), resourceId(fullFileByPath(doc, pathToFileURL('C:\\Media\\baked-camera.mov').href)),
    'camera audio remains attached to the original source file');
  assert.notEqual(fileId(originalAudio), fileId(bakedVideoItem), 'baked picture and native audio use their respective media files');
  assert.equal(fileId(untouched), resourceId(fullFileByPath(doc, pathToFileURL('C:\\Media\\ordinary-camera.mov').href)),
    'an unselected camera keeps its original media reference');
}

// ── When audio itself is rendered, its replacement starts at zero with no second trim ──
{
  const audio = clip('baked-audio', 'A1', 'audio', 12, 20, {
    src: '/media/uploads/baked-audio.wav',
    srcInFrame: 40,
  });
  const bakedMedia = { 'baked-audio': { audioSrc: 'C:\\Renders\\baked audio.wav' } };
  const doc = parse(exportXml(state([audio]), { bakedMedia }));
  const emitted = clipItems(mediaTracks(sequence(doc), 'audio')[0]!)[0]!;
  assert.deepEqual([text(emitted, 'start'), text(emitted, 'end'), text(emitted, 'in'), text(emitted, 'out')],
    ['12', '32', '0', '20'], 'audioSrc replaces the original source window and speed with the rendered timeline span');
  assert.equal(text(fullFileByPath(doc, pathToFileURL('C:\\Renders\\baked audio.wav').href), 'name'), 'baked audio.wav');
}

// ── Mixed-rate retime, source-clock-separated links and audio gain/fades ──
{
  const src = '/media/uploads/retimed-mixed-clock.mov';
  const originalPath = 'C:\\Camera Originals\\retimed.mov';
  const proxyPath = 'C:\\Working Copies\\retimed.mov';
  const bakedPicture = 'C:\\Renders\\retimed picture.mov';
  const item = clip('retimed-mixed-clock', 'V1', 'video', 15, 30, {
    src,
    srcInFrame: 90,
    originalFilePath: originalPath,
    sourceAssetId: 'retimed-asset',
    playbackRate: 2,
    volume: 0.5,
    fadeInFrames: 30,
    fadeOutFrames: 30,
  });
  const sourceTc = { value: 90_000, timescale: 25, timecode: '01:00:00:00', dropFrame: false };
  const sourceRate = { numerator: 25, denominator: 1 };
  const mediaSources = {
    [src]: {
      path: proxyPath,
      originalPath,
      pathRate: { numerator: 30, denominator: 1 },
      originalRate: sourceRate,
      pathStart: { value: 1_080_000, timescale: 30, timecode: '10:00:00:00', dropFrame: false },
      originalStart: sourceTc,
    },
  } as unknown as ExportMediaSourceMap;
  const timeline = state([item], {
    assets: [{
      id: 'retimed-asset', name: 'retimed.mov', src, kind: 'video', durationInFrames: 240,
      originalFilePath: originalPath,
      sourceTimecode: { frameCount: 90_000, frameRate: sourceRate, dropFrame: false },
    }],
  });
  const doc = parse(exportXml(timeline, { mediaSources, bakedMedia: { [item.id]: { visualSrc: bakedPicture } } }));
  const seq = sequence(doc);
  const picture = clipItems(mediaTracks(seq, 'video')[0]!)[0]!;
  const audio = mediaTracks(seq, 'audio').flatMap(clipItems).find((candidate) => clipName(candidate) === item.name)!;
  assert.ok(picture && audio, 'the rendered picture remains linked with the original native audio');
  assert.equal(text(fullFileByPath(doc, pathToFileURL(bakedPicture).href), 'pathurl'), pathToFileURL(bakedPicture).href,
    'a rendered visual path wins over item.originalFilePath');
  assert.equal(text(fullFileByPath(doc, pathToFileURL(originalPath).href), 'pathurl'), pathToFileURL(originalPath).href,
    'the linked unbaked audio still resolves to the original source');
  assert.equal(Array.from(doc.getElementsByTagName('pathurl')).some((node) => node.textContent === pathToFileURL(proxyPath).href), false,
    'an original-path export does not accidentally use a distinct working proxy');
  assert.deepEqual([text(picture, 'start'), text(picture, 'end'), text(picture, 'in'), text(picture, 'out')],
    ['15', '45', '0', '30'], 'baked picture is placed on the project clock with a zero-origin output window');
  assert.deepEqual(frameRate(audio), ['25', 'FALSE'], 'unbaked companion audio runs on the native original clock');
  assert.deepEqual([text(audio, 'start'), text(audio, 'end'), text(audio, 'in'), text(audio, 'out')],
    ['15', '45', '37', '62'], 'mixed-rate audio uses native retime bounds but keeps project placement frames');
  assert.deepEqual([text(child(fullFileByPath(doc, pathToFileURL(originalPath).href), 'timecode'), 'string'),
    text(child(fullFileByPath(doc, pathToFileURL(originalPath).href), 'timecode'), 'frame')],
    ['01:00:00:00', '90000'], 'source timecode origin is retained independently of relative retime in/out');
  const retime = effectFor(audio, 'timeremap', 'audio');
  const graph = effectKeyframes(effectParameter(retime, 'graphdict'));
  assert.deepEqual(graph.map(({ when, value }) => [when, value]), [
    ['0', '1'], ['37', '75'], ['62', '125'], ['100', '201'],
  ], 'the audio retime graph has the agreed mixed-rate anchors and a full-media endpoint');
  assert.deepEqual(graph.map(({ flags }) => flags), [
    ['speedvirtualkf', 'speedkfstart'], ['speedkfin'], ['speedkfout'], ['speedvirtualkf', 'speedkfend'],
  ], 'retime graph keyframe boundary roles are explicit');
  const level = effectParameter(effectFor(audio, 'audiolevels', 'audio'), 'level');
  assert.deepEqual(effectKeyframes(level).map(({ when, value }) => [when, value]), [
    ['37', '0'], ['50', '0.25'], ['62', '0'],
  ], 'gain/fade keyframes convert local project frames to the native source clock from adjusted I');
  assert.deepEqual([text(audio, 'duration'), text(audio, 'end')], ['100', '45'],
    'the retime envelope duration does not pad the clip placement on the sequence');
}

// ── Short clips and disabled tracks keep their exact sequence state ──
{
  const short = video('one-frame', 9, 1);
  const hidden = clip('hidden-clip', 'V2', 'video', 0, 30, {
    effects: [{ id: 'fx', assetId: 'builtin:fx-test' }],
  });
  const muted = clip('muted-audio', 'A1', 'audio', 0, 30);
  const disabledState = state([short, hidden, muted], {
    trackOrder: ['V2', 'V1', 'A1'],
    tracks: { V2: { kind: 'video', hidden: true }, V1: { kind: 'video' }, A1: { kind: 'audio', muted: true } },
  });
  const doc = parse(exportXml(disabledState, {
    bakedMedia: { 'hidden-clip': { visualSrc: 'C:\\Renders\\hidden.mov' } },
  }));
  const seq = sequence(doc);
  const shortClip = clipItems(mediaTracks(seq, 'video')[0]!)[0]!;
  assert.deepEqual([text(shortClip, 'start'), text(shortClip, 'end'), text(shortClip, 'duration')], ['9', '10', '1'],
    'a one-frame clip is not padded to a frame-rate-sized minimum');
  assert.equal(text(mediaTracks(seq, 'video')[1]!, 'enabled'), 'FALSE', 'hidden video track is disabled in XMEML');
  assert.equal(text(mediaTracks(seq, 'audio')[0]!, 'enabled'), 'FALSE', 'muted audio track is disabled in XMEML');
}

// ── Automatic contain/cover scaling uses source dimensions without baking ──
{
  const src = '/media/uploads/fit-source.mov';
  const originalFilePath = 'C:\\Media\\fit source.mov';
  const fitItem = video('fit-source', 0, 60, {
    src,
    sourceAssetId: 'fit-source-asset',
    originalFilePath,
  });
  const asset = {
    id: 'fit-source-asset', name: 'fit source.mov', src, kind: 'video' as const,
    durationInFrames: 60, width: 800, height: 600, originalFilePath,
  };
  for (const [fit, expectedScale] of [['contain', '180'], ['cover', '240']] as const) {
    const timeline = state([fitItem], { fit, assets: [asset] });
    const plan = planPremiereExport(timeline);
    assert.deepEqual(plan.bakeJobs, [], `${fit} conform is a native Basic Motion effect, not a flattened visual bake`);
    const doc = parse(exportXml(timeline));
    const seq = sequence(doc);
    const picture = clipItems(mediaTracks(seq, 'video')[0]!)[0]!;
    const sourceFile = fullFileByPath(doc, pathToFileURL(originalFilePath).href);
    assert.equal(resourceId(clipFile(picture)), sourceFile.getAttribute('id'),
      `${fit} continues to reference the original source media`);
    const sample = child(child(child(sourceFile, 'media'), 'video'), 'samplecharacteristics');
    assert.deepEqual([text(sample, 'width'), text(sample, 'height')], ['800', '600'],
      'the file declaration preserves source dimensions, not sequence canvas dimensions');
    const basic = effectFor(picture, 'basic', 'video');
    assert.equal(text(effectParameter(basic, 'scale'), 'value'), expectedScale,
      `${fit} computes the documented ${expectedScale}% centered scale from 800x600 to 1920x1080`);
    const center = child(effectParameter(basic, 'center'), 'value');
    assert.deepEqual([text(center, 'horiz'), text(center, 'vert')], ['0', '0'],
      `${fit} keeps Basic Motion centered`);
  }

  const unknownSrc = '/media/uploads/unknown-dimensions.mov';
  const unknownTimeline = state([video('unknown-dimensions', 0, 30, { src: unknownSrc })], { fit: 'contain' });
  const unknownPlan = planPremiereExport(unknownTimeline);
  assert.ok(unknownPlan.issues.some((issue) => issue.severity === 'warning'
    && issue.code === 'premiere-source-dimensions-unknown'
    && issue.itemIds.includes('unknown-dimensions')),
  'unknown dimensions produce a visible warning that leaves Premiere default scale in place');
}

// ── Stable output for the same project/options ──
{
  const sample = state([video('stable', 5, 10, { name: 'Stable & repeatable' })]);
  const first = exportXml(sample, { title: 'Stable' });
  const second = exportXml(sample, { title: 'Stable' });
  assert.equal(first, second, 'serializer output is byte-for-byte deterministic');
}

// ── Reject ambiguous IDs and invalid source-frame windows ──
{
  const first = video('duplicate-serializer-id', 0, 10);
  const duplicate = clip('duplicate-serializer-id', 'V2', 'video', 30, 10);
  assert.throws(() => exportXml(state([first, duplicate])), /unique|duplicate/i,
    'serializer rejects duplicate clip IDs before they can collide in links');
  for (const srcInFrame of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = video(`invalid-serializer-in-${String(srcInFrame)}`, 0, 10, { srcInFrame });
    assert.throws(() => exportXml(state([invalid])), /source in-point|source frame/i,
      `${String(srcInFrame)} source in-point is rejected instead of silently shifting its cut`);
  }
}

console.log('premiere.verify: ok (XMEML DOM/track order/source clocks/rates/links/transcript/baked media/determinism)');
