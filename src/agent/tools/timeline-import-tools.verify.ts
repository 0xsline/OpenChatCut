import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { timelineToFcpxml } from '../../export/fcpxml';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execTimelineImportTool, parseTimelineImport } from './timeline-import-tools';

function context(extraAssets: MediaAsset[] = []) {
  const doc = docFromTimeline({
    fps: 30,
    width: 1280,
    height: 720,
    selectedId: null,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [],
  });
  doc.assets.push({
    id: 'video-asset',
    name: 'clip.mp4',
    kind: 'video',
    src: '/media/uploads/clip.mp4',
    originalFilePath: '/Users/test/clip.mp4',
    durationInFrames: 900,
    width: 1920,
    height: 1080,
  }, ...extraAssets);
  const draft = makeDraft(doc);
  return {
    draft,
    ctx: {
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    } as AgentContext,
  };
}

const fcpxml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10"><resources>
  <format id="r1" frameDuration="1/25s" width="1920" height="1080"/>
  <asset id="r2" name="clip.mp4"><media-rep src="file:///Users/test/clip.mp4"/></asset>
</resources><library><event><project name="FCP Import"><sequence format="r1"><spine>
  <asset-clip ref="r2" name="clip.mp4" offset="1s" start="2s" duration="3s"/>
</spine></sequence></project></event></library></fcpxml>`;

{
  const { draft, ctx } = context();
  const originalTimelineId = draft.getDoc().activeTimelineId;
  const result = await execTimelineImportTool('import_timeline', {
    format: 'fcpxml', content: fcpxml, activate: false,
  }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.startTimecode, '00:00:00:00');
  assert.deepEqual(result.skipped, []);
  assert.equal(result.skippedCount, 0);
  assert.equal(draft.getDoc().activeTimelineId, originalTimelineId, 'activate=false keeps the current timeline selected');
  const imported = draft.getDoc().timelines.find((timeline) => timeline.id === result.timelineId)!;
  assert.equal(imported.name, 'FCP Import');
  // The 25 fps sequence joins the 30 fps project at its rate (#184): 1 s in, 3 s long, from 2 s.
  assert.equal(imported.fps, 30);
  assert.equal(result.fps, 30);
  assert.deepEqual(result.warnings, [
    'the 25 fps sequence was converted to the project frame rate (30 fps); cut points are rounded to the nearest frame',
  ]);
  assert.equal(imported.width, 1920);
  assert.equal(imported.items.length, 1);
  assert.deepEqual(
    {
      sourceAssetId: imported.items[0]!.sourceAssetId,
      startFrame: imported.items[0]!.startFrame,
      durationInFrames: imported.items[0]!.durationInFrames,
      srcInFrame: imported.items[0]!.srcInFrame,
    },
    { sourceAssetId: 'video-asset', startFrame: 30, durationInFrames: 90, srcInFrame: 60 },
  );
}

{
  const { draft, ctx } = context();
  const edl = `TITLE: EDL Import
FCM: NON-DROP FRAME
001 CLIP V C 00:00:01:00 00:00:03:00 00:00:10:00 00:00:12:00
* FROM CLIP NAME: clip.mp4`;
  const result = await execTimelineImportTool('import_timeline', { format: 'edl', content: edl }, ctx);
  assert.equal(result.ok, true);
  const imported = draft.getDoc().timelines.find((timeline) => timeline.id === result.timelineId)!;
  assert.deepEqual(
    {
      sourceAssetId: imported.items[0]!.sourceAssetId,
      startFrame: imported.items[0]!.startFrame,
      durationInFrames: imported.items[0]!.durationInFrames,
      srcInFrame: imported.items[0]!.srcInFrame,
    },
    { sourceAssetId: 'video-asset', startFrame: 300, durationInFrames: 60, srcInFrame: 30 },
  );
}

{
  const { draft } = context();
  const before = draft.getDoc().timelines.length;
  const missing = await parseTimelineImport('fcpxml', fcpxml, [], draft.getState());
  assert.equal(missing.ok, false);
  assert.equal(draft.getDoc().timelines.length, before, 'parse failure leaves the project unchanged');
  const entity = await parseTimelineImport('fcpxml', '<!DOCTYPE x [<!ENTITY y "z">]><fcpxml/>', [], draft.getState());
  assert.equal(entity.ok, false, 'XML entities are rejected at the boundary');
}

{
  const { draft } = context();
  const dropFrame = `TITLE: Drop Frame
FCM: DROP FRAME
001 CLIP V C 00:01:00;02 00:01:01;02 00:01:00;02 00:01:01;02
* FROM CLIP NAME: clip.mp4`;
  // The source in-point must lie inside the file: 00:01:00;02 needs more than 30 seconds of media.
  const longClip = draft.getDoc().assets.map((asset) => ({ ...asset, durationInFrames: 3600 }));
  const parsed = await parseTimelineImport('edl', dropFrame, longClip, draft.getState());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    // 00:01:00;02 is frame 1800 at 29.97, 60.06 s: frame 1802 of the 30 fps project.
    assert.equal(parsed.timeline.sourceFps, 30000 / 1001);
    assert.equal(parsed.timeline.fps, 30);
    assert.equal(parsed.timeline.clips[0]!.startFrame, 1802);
    assert.equal(parsed.timeline.clips[0]!.sourceStartFrame, 1802);
    assert.equal(parsed.timeline.clips[0]!.durationInFrames, 30);
  }
  const outside = await parseTimelineImport('edl', dropFrame, draft.getDoc().assets, draft.getState());
  assert.equal(outside.ok, false, 'a source timecode past the end of a file without timecode is reported, not imported');
  if (!outside.ok) assert.match(outside.skipped?.[0]?.reason ?? '', /source timecode lies outside clip\.mp4/);
}

// ── OpenChatCut FCPXML export → import round trip: tracks, positions, in-points and speed survive ──
{
  const broll: MediaAsset = { id: 'broll', name: 'broll.mp4', kind: 'video', src: '/media/uploads/broll.mp4', durationInFrames: 1800 };
  const music: MediaAsset = { id: 'music', name: 'music.mp3', kind: 'audio', src: '/media/uploads/music.mp3', durationInFrames: 1800 };
  const { draft, ctx } = context([broll, music]);
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['V2', 'V1', 'A1'],
    tracks: { V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
    assets: draft.getDoc().assets,
    items: [
      { id: 'a', track: 'V1', kind: 'video', name: 'clip.mp4', src: '/media/uploads/clip.mp4', startFrame: 0, durationInFrames: 90, srcInFrame: 30 },
      { id: 'b', track: 'V1', kind: 'video', name: 'broll.mp4', src: '/media/uploads/broll.mp4', startFrame: 120, durationInFrames: 60, playbackRate: 2 },
      { id: 'c', track: 'V2', kind: 'video', name: 'broll.mp4', src: '/media/uploads/broll.mp4', startFrame: 45, durationInFrames: 30, srcInFrame: 300 },
      { id: 'd', track: 'A1', kind: 'audio', name: 'music.mp3', src: '/media/uploads/music.mp3', startFrame: 10, durationInFrames: 200, srcInFrame: 15 },
    ],
  };
  const xml = timelineToFcpxml(state, { title: 'Round Trip', mediaDir: '/Users/test/media' });
  const result = await execTimelineImportTool('import_timeline', { format: 'fcpxml', content: xml }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const imported = draft.getDoc().timelines.find((timeline) => timeline.id === result.timelineId)!;
  const trackName = (id: string) => imported.tracks?.[id]?.name;
  assert.equal(imported.name, 'Round Trip');
  assert.equal(imported.fps, 30);
  assert.deepEqual((imported.trackOrder ?? []).map(trackName), ['Imported V2', 'Imported V1', 'Imported A1']);
  const trackOf: Record<string, string> = { V2: 'Imported V2', V1: 'Imported V1', A1: 'Imported A1' };
  const shape = (item: { startFrame: number; durationInFrames: number; srcInFrame?: number; playbackRate?: number }) => ({
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
    srcInFrame: item.srcInFrame ?? 0,
    playbackRate: item.playbackRate ?? 1,
  });
  const roundTripped = imported.items
    .map((item) => ({ track: trackName(item.track), ...shape(item) }))
    .sort((left, right) => left.track!.localeCompare(right.track!) || left.startFrame - right.startFrame);
  const original = state.items
    .map((item) => ({ track: trackOf[item.track], ...shape(item) }))
    .sort((left, right) => left.track!.localeCompare(right.track!) || left.startFrame - right.startFrame);
  assert.deepEqual(roundTripped, original);
}

// ── Round trip on the files' own timecode (#27): timecoded assets and retimed clips keep their in-points ──
{
  const camera: MediaAsset = { id: 'camera', name: 'A001.mov', kind: 'video', src: '/media/uploads/camera.mov', durationInFrames: 1800 };
  const ntsc: MediaAsset = { id: 'ntsc', name: 'B001.mov', kind: 'video', src: '/media/uploads/ntsc.mov', durationInFrames: 1800 };
  const { draft, ctx } = context([camera, ntsc]);
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['V2', 'V1'],
    tracks: { V2: { kind: 'video' }, V1: { kind: 'video' } },
    assets: draft.getDoc().assets,
    items: [
      { id: 'a', track: 'V1', kind: 'video', name: 'A001.mov', src: camera.src, startFrame: 0, durationInFrames: 60, srcInFrame: 45 },
      { id: 'b', track: 'V1', kind: 'video', name: 'A001.mov', src: camera.src, startFrame: 60, durationInFrames: 40, srcInFrame: 90, playbackRate: 2 },
      { id: 'c', track: 'V2', kind: 'video', name: 'B001.mov', src: ntsc.src, startFrame: 10, durationInFrames: 30, srcInFrame: 33, playbackRate: 1.5 },
      { id: 'd', track: 'V2', kind: 'video', name: 'clip.mp4', src: '/media/uploads/clip.mp4', startFrame: 50, durationInFrames: 30, srcInFrame: 60, playbackRate: 2 },
      { id: 'e', track: 'V2', kind: 'video', name: 'clip.mp4', src: '/media/uploads/clip.mp4', startFrame: 90, durationInFrames: 40, srcInFrame: 12, playbackRate: 0.5 },
    ],
  };
  // What /api/export-media-sources reports: 10:00:00:00 at 25 fps, 01:00:00;00 drop-frame at 29.97, and no timecode.
  const pal = { value: 900_000, timescale: 25, timecode: '10:00:00:00', dropFrame: false };
  const dropFrame = { value: 107_999_892, timescale: 30_000, timecode: '01:00:00;00', dropFrame: true };
  const xml = timelineToFcpxml(state, {
    title: 'Timecode Round Trip',
    mediaDir: '/Users/test/media',
    mediaSources: {
      [camera.src]: { path: '/Volumes/A001/A001.mov', originalPath: '/Volumes/A001/A001.mov', pathStart: pal, originalStart: pal },
      [ntsc.src]: { path: '/Volumes/B001/B001.mov', originalPath: '/Volumes/B001/B001.mov', pathStart: dropFrame, originalStart: dropFrame },
      '/media/uploads/clip.mp4': { path: '/Users/test/clip.mp4' },
    },
  });
  assert.match(xml, /<asset [^>]*name="A001\.mov" start="900000\/25s"/, 'the camera file exports on its timecode');
  assert.match(xml, /<asset [^>]*name="B001\.mov" start="107999892\/30000s"/, 'drop-frame timecode exports exactly');
  const result = await execTimelineImportTool('import_timeline', { format: 'fcpxml', content: xml }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const imported = draft.getDoc().timelines.find((timeline) => timeline.id === result.timelineId)!;
  const trackName = (id: string) => imported.tracks?.[id]?.name;
  const trackOf: Record<string, string> = { V2: 'Imported V2', V1: 'Imported V1' };
  const shape = (item: { sourceAssetId?: string; startFrame: number; durationInFrames: number; srcInFrame?: number; playbackRate?: number }) => ({
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
    srcInFrame: item.srcInFrame ?? 0,
    playbackRate: item.playbackRate ?? 1,
  });
  const byPosition = (left: { track?: string; startFrame: number }, right: { track?: string; startFrame: number }) => (
    left.track!.localeCompare(right.track!) || left.startFrame - right.startFrame);
  assert.deepEqual(
    imported.items.map((item) => ({ track: trackName(item.track), asset: item.sourceAssetId, ...shape(item) })).sort(byPosition),
    state.items.map((item) => ({
      track: trackOf[item.track],
      asset: draft.getDoc().assets.find((asset) => asset.src === item.src)?.id,
      ...shape(item),
    })).sort(byPosition),
    'in-points count from each file\'s own start, through retime maps too',
  );
}

// ── EDL-only options are ignored for FCPXML, with a warning ──
{
  const { ctx } = context();
  const result = await execTimelineImportTool('import_timeline', {
    format: 'fcpxml', content: fcpxml, fps: 24, startTimecode: '01:00:00:00',
  }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.fps, 30);
  assert.match((result.warnings as string[])[0] ?? '', /apply to EDL only/);
  assert.match((result.warnings as string[])[1] ?? '', /^the 25 fps sequence was converted/, 'read at the sequence format, not the fps argument');
}

// ── Malformed input fails as a result, never as an exception ──
{
  const { draft } = context();
  // Chrome and Safari keep the partial document and insert a <parsererror> into it.
  const { DOMParser: XmlDomParser } = await import('@xmldom/xmldom');
  const globals = globalThis as { DOMParser?: unknown };
  const browserParser = globals.DOMParser;
  globals.DOMParser = class {
    parseFromString(text: string, type: string) {
      const partial = text.replace('<resources>', '<parsererror xmlns="http://www.w3.org/1999/xhtml"><h3>This page contains the following errors:</h3><div>error on line 2 at column 12: Opening and ending tag mismatch</div><h3>Below is a rendering of the page up to the first error.</h3></parsererror><resources>');
      return new XmlDomParser().parseFromString(partial, type);
    }
  };
  try {
    const partial = await parseTimelineImport('fcpxml', fcpxml, draft.getDoc().assets, draft.getState());
    assert.deepEqual(partial, { ok: false, error: 'invalid FCPXML: error on line 2 at column 12: Opening and ending tag mismatch' });
  } finally {
    if (browserParser === undefined) delete globals.DOMParser;
    else globals.DOMParser = browserParser;
  }
  const depth = 20_000;
  const nested = `<fcpxml version="1.9"><resources/><library><event><project name="deep"><sequence><spine>${
    '<clip offset="0s" duration="1s">'.repeat(depth)}${'</clip>'.repeat(depth)}</spine></sequence></project></event></library></fcpxml>`;
  const deep = await parseTimelineImport('fcpxml', nested, [], draft.getState());
  assert.equal(deep.ok, false, 'a pathologically nested document is refused without throwing');
}

console.log('timeline-import-tools.verify: all assertions passed');
