// FCPXML import timing: every time must land in sequence time (#106).
// Fixtures are hand-written after real exports: DaVinci Resolve 1.9 (tcStart
// "3600/1s", audio anchored to a one-frame head gap, per-clip sub-range assets)
// and Final Cut Pro 1.9-1.11 (29.97 tcStart, gaps with start="3600s",
// connected storylines, detached audio, sync-clips on camera timecode, compound
// and multicam clips, conform-rate), cf. the orchetect/swift-fcpxml and
// OpenTimelineIO otio-fcpx-xml-adapter sample files.
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execTimelineImportTool, parseTimelineImport } from './timeline-import-tools';

type PoolEntry = Pick<MediaAsset, 'id' | 'name' | 'kind'> & Partial<MediaAsset> & { seconds?: number };

function context(pool: PoolEntry[], fps = 30) {
  const doc = docFromTimeline({
    fps, width: 1280, height: 720, selectedId: null, trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, items: [],
  });
  for (const { seconds, ...entry } of pool) {
    doc.assets.push({
      src: `/media/uploads/${entry.id}`,
      durationInFrames: Math.round((seconds ?? 60) * fps),
      ...entry,
    } as MediaAsset);
  }
  const draft = makeDraft(doc);
  const ctx = {
    commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
    getCreativeMode: () => null, templates: [], audio: [],
  } as AgentContext;
  return { draft, ctx };
}

async function importFcpxml(content: string, pool: PoolEntry[], fps = 30) {
  const { draft, ctx } = context(pool, fps);
  const result = await execTimelineImportTool('import_timeline', { format: 'fcpxml', content }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const timeline = draft.getDoc().timelines.find((item) => item.id === result.timelineId)!;
  const trackName = (id: string) => timeline.tracks?.[id]?.name ?? id;
  const items = timeline.items
    .map((item: TimelineItem) => ({
      asset: item.sourceAssetId,
      track: trackName(item.track),
      start: item.startFrame,
      duration: item.durationInFrames,
      srcIn: item.srcInFrame ?? 0,
      ...(item.playbackRate !== undefined ? { rate: item.playbackRate } : {}),
      ...(item.volume === 0 ? { muted: true } : {}),
    }))
    .sort((left, right) => left.track.localeCompare(right.track) || left.start - right.start);
  return { result, timeline, items, order: (timeline.trackOrder ?? []).map(trackName) };
}

const reasons = (result: Record<string, unknown>) => (result.skipped as Array<{ element: string; reason: string; at?: string }>)
  .map((entry) => `${entry.element}@${entry.at ?? '?'}: ${entry.reason}`);

const document = (resources: string, sequence: string, version = '1.9') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="${version}">
  <resources>${resources}</resources>
  <library><event name="Timeline 1"><project name="Imported Project">${sequence}</project></event></library>
</fcpxml>`;

const mediaRep = (file: string) => `<media-rep kind="original-media" src="file:///Volumes/Media/${file}"/>`;

// ── DaVinci Resolve style: tcStart 01:00:00:00, camera timecode asset, anchored lanes ──
{
  const xml = document(`
    <format id="r0" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="r1" name="A001C003.mov" start="3600/1s" duration="60/1s" hasVideo="1" hasAudio="1" format="r0">${mediaRep('A001C003.mov')}</asset>
    <asset id="r2" name="score.wav" start="0/1s" duration="180/1s" hasAudio="1">${mediaRep('score.wav')}</asset>
    <asset id="r3" name="B002C001.mov" start="0/1s" duration="120/1s" hasVideo="1" hasAudio="1" format="r0">${mediaRep('B002C001.mov')}</asset>`, `
    <sequence format="r0" tcStart="3600/1s" tcFormat="NDF" duration="20/1s">
      <spine>
        <gap name="Gap" offset="3600/1s" start="3600/1s" duration="1/30s">
          <asset-clip ref="r2" lane="-1" offset="3600/1s" start="10/1s" duration="20/1s" name="score.wav"/>
        </gap>
        <asset-clip ref="r1" offset="108001/30s" start="3605/1s" duration="299/30s" audioStart="3605/1s" audioDuration="299/30s" name="A001C003.mov">
          <asset-clip ref="r3" lane="1" offset="3607/1s" start="2/1s" duration="3/1s" name="B002C001.mov"/>
        </asset-clip>
        <asset-clip ref="r3" offset="3610/1s" start="30/1s" duration="10/1s" audioStart="30/1s" audioDuration="9/1s" name="B002C001.mov"/>
      </spine>
    </sequence>`);
  const { result, items, order } = await importFcpxml(xml, [
    { id: 'cam', name: 'A001C003.mov', kind: 'video', seconds: 60, originalFilePath: '/Volumes/Media/A001C003.mov' },
    { id: 'score', name: 'score.wav', kind: 'audio', seconds: 180 },
    { id: 'broll', name: 'B002C001.mov', kind: 'video', seconds: 120 },
  ]);
  assert.equal(result.startTimecode, '01:00:00:00');
  assert.deepEqual(order, ['Imported V2', 'Imported V1', 'Imported A1'], 'lane 1 stacks above the spine, audio below');
  assert.deepEqual(items, [
    // Anchored audio is not limited by its one-frame parent gap.
    { asset: 'score', track: 'Imported A1', start: 0, duration: 600, srcIn: 300 },
    // tcStart subtracted; in-point measured from the asset's 01:00:00:00 start.
    { asset: 'cam', track: 'Imported V1', start: 1, duration: 299, srcIn: 150 },
    { asset: 'broll', track: 'Imported V1', start: 300, duration: 300, srcIn: 900 },
    // Connected clip: parent offset + (child offset - parent start).
    { asset: 'broll', track: 'Imported V2', start: 61, duration: 90, srcIn: 60 },
  ]);
  // Resolve writes audioStart/audioDuration on every clip; only a real split edit is worth a warning.
  assert.deepEqual(result.warnings, [
    'asset-clip "B002C001.mov" at 01:00:10:00: split-edit audio (audioStart/audioDuration) follows the video timing',
  ]);
}

// ── Final Cut Pro style at 29.97: gaps with start=3600s, storylines, detached audio, sync/compound/audition ──
{
  const f = (frames: number) => `${frames * 1001}/30000s`;
  const at3600 = (frames: number) => `${108_000_000 + frames * 1001}/30000s`; // 3600s + frames
  const cam = 1_296_000; // camera clock 12:00:00:00 NDF, in frames
  const recorder = 1_295_000;
  const xml = document(`
    <format id="r1" name="FFVideoFormat1080p2997" frameDuration="1001/30000s" width="1920" height="1080"/>
    <asset id="rInt" name="Interview" start="0s" duration="120s" hasVideo="1" hasAudio="1" format="r1">${mediaRep('Interview.mov')}</asset>
    <asset id="rBroll" name="Broll" start="0s" duration="60s" hasVideo="1" hasAudio="1" format="r1">${mediaRep('Broll.mov')}</asset>
    <asset id="rCam" name="A001C007" start="${f(cam)}" duration="120s" hasVideo="1" hasAudio="1" format="r1">${mediaRep('A001C007.mov')}</asset>
    <asset id="rRec" name="ZOOM0001" start="${f(recorder)}" duration="180s" hasAudio="1">${mediaRep('ZOOM0001.WAV')}</asset>
    <effect id="rTitle" name="Basic Title" uid=".../Basic Title.moti"/>
    <media id="rCompound" name="Compound">
      <sequence format="r1" tcStart="0s" duration="${f(150)}">
        <spine>
          <asset-clip ref="rBroll" offset="0s" start="${f(1000)}" duration="${f(50)}" name="Broll"/>
          <asset-clip ref="rCam" offset="${f(50)}" start="${f(cam + 500)}" duration="${f(100)}" name="A001C007"/>
        </spine>
      </sequence>
    </media>`, `
    <sequence format="r1" tcStart="${f(108_000)}" tcFormat="NDF" duration="${f(930)}">
      <spine>
        <clip name="Interview" offset="${f(108_000)}" duration="${f(300)}">
          <video ref="rInt" offset="0s" duration="${f(3596)}"/>
          <clip name="Interview" lane="-1" offset="0s" duration="${f(300)}">
            <gap name="Gap" offset="0s" duration="${f(3596)}">
              <audio ref="rInt" lane="-1" offset="0s" duration="${f(3596)}" srcCh="1"/>
            </gap>
          </clip>
        </clip>
        <transition name="Cross Dissolve" offset="${f(108_285)}" duration="${f(30)}"/>
        <gap name="Gap" offset="${f(108_300)}" start="3600s" duration="${f(300)}">
          <asset-clip ref="rBroll" lane="1" offset="${at3600(30)}" start="${f(60)}" duration="${f(90)}" name="Broll"/>
          <spine lane="2" offset="${at3600(60)}">
            <asset-clip ref="rBroll" offset="0s" start="${f(200)}" duration="${f(45)}" name="Broll"/>
            <asset-clip ref="rCam" offset="${f(45)}" start="${f(cam + 20)}" duration="${f(45)}" name="A001C007"/>
          </spine>
        </gap>
        <sync-clip name="Sync" offset="${f(108_600)}" start="${f(cam + 100)}" duration="${f(150)}">
          <clip name="A001C007" offset="${f(cam)}" start="${f(cam)}" duration="${f(3596)}">
            <video ref="rCam" offset="${f(cam)}" start="${f(cam)}" duration="${f(3596)}"/>
            <asset-clip ref="rRec" lane="-1" offset="${f(cam - 50)}" start="${f(recorder + 10)}" duration="${f(600)}" name="ZOOM0001"/>
          </clip>
        </sync-clip>
        <ref-clip ref="rCompound" name="Compound" offset="${f(108_750)}" start="${f(20)}" duration="${f(60)}"/>
        <title ref="rTitle" name="Lower Third" offset="${f(108_810)}" start="3600s" duration="${f(60)}"/>
        <asset-clip ref="rBroll" name="Disabled" offset="${f(108_870)}" duration="${f(30)}" enabled="0"/>
        <audition offset="${f(108_900)}">
          <asset-clip ref="rBroll" name="Pick A" start="${f(300)}" duration="${f(30)}"/>
          <asset-clip ref="rCam" name="Pick B" start="${f(cam)}" duration="${f(30)}"/>
        </audition>
      </spine>
    </sequence>`, '1.11');
  const { result, items, order, timeline } = await importFcpxml(xml, [
    { id: 'interview', name: 'Interview.mov', kind: 'video', seconds: 120 },
    { id: 'broll', name: 'Broll.mov', kind: 'video', seconds: 60 },
    { id: 'cam', name: 'A001C007.mov', kind: 'video', seconds: 120 },
    { id: 'rec', name: 'ZOOM0001.WAV', kind: 'audio', seconds: 180 },
  ]);
  assert.equal(timeline.fps, 30000 / 1001);
  assert.equal(result.startTimecode, '01:00:00:00');
  assert.deepEqual(order, ['Imported V3', 'Imported V2', 'Imported V1', 'Imported A1']);
  assert.deepEqual(items, [
    // Anchored to the sync-clip's primary clip, 150 frames before the window: clipped to it.
    { asset: 'rec', track: 'Imported A1', start: 600, duration: 150, srcIn: 160 },
    // Detached audio of the same file in sync merges into this clip.
    { asset: 'interview', track: 'Imported V1', start: 0, duration: 300, srcIn: 0 },
    // Sync-clip local time runs on the camera clock (12:00:00:00 + 100 frames).
    { asset: 'cam', track: 'Imported V1', start: 600, duration: 150, srcIn: 100 },
    // Compound clip trimmed to compound time [20, 80).
    { asset: 'broll', track: 'Imported V1', start: 750, duration: 30, srcIn: 1020 },
    { asset: 'cam', track: 'Imported V1', start: 780, duration: 30, srcIn: 500 },
    // Audition: the active (first) pick at the audition's offset.
    { asset: 'broll', track: 'Imported V1', start: 900, duration: 30, srcIn: 300 },
    // Connected clip in a gap whose local timeline starts at 3600s.
    { asset: 'broll', track: 'Imported V2', start: 330, duration: 90, srcIn: 60 },
    // Connected storyline: gap offset + storyline offset + clip offset.
    { asset: 'broll', track: 'Imported V3', start: 360, duration: 45, srcIn: 200 },
    { asset: 'cam', track: 'Imported V3', start: 405, duration: 45, srcIn: 20 },
  ]);
  assert.deepEqual(reasons(result), [
    'transition@01:00:09:15: transitions are not imported; the clips meet with a cut',
    'title@01:00:27:00: titles are not imported',
    'asset-clip@01:00:29:00: disabled clip',
  ]);
  assert.ok((result.warnings as string[]).some((warning) => /1 audio component\(s\) of video files were merged/.test(warning)));
}

// ── Rate conform: 25p media in a 24p project (FCP "24With25Media") ──
{
  const xml = document(`
    <format id="r1" name="FFVideoFormat1080p24" frameDuration="100/2400s" width="1920" height="1080"/>
    <format id="r3" name="FFVideoFormat1080p25" frameDuration="100/2500s" width="1920" height="1080"/>
    <asset id="r2" name="TestVideo" start="0s" duration="738000/25000s" hasVideo="1" format="r3">${mediaRep('TestVideo.mov')}</asset>`, `
    <sequence format="r1" tcStart="3600s" tcFormat="NDF">
      <spine>
        <gap name="Gap" offset="3600s" start="3600s" duration="10s"/>
        <asset-clip ref="r2" offset="3610s" name="TestVideo" start="684/25s" duration="9/4s" format="r3">
          <conform-rate srcFrameRate="25"/>
        </asset-clip>
      </spine>
    </sequence>`, '1.11');
  const { items, timeline } = await importFcpxml(xml, [{ id: 'test', name: 'TestVideo.mov', kind: 'video', seconds: 29.52 }]);
  assert.equal(timeline.fps, 24);
  // 2.25 s at 24/25 speed plays media 27.36-29.52 s: exactly to the end of the file.
  assert.deepEqual(items, [{ asset: 'test', track: 'Imported V1', start: 240, duration: 54, srcIn: 657, rate: 0.96 }]);
}

// ── Retime: constant 50 % (start is adjusted time), a ramp, and reverse ──
{
  const xml = document(`
    <format id="r0" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="r1" name="Broll" start="0s" duration="60s" hasVideo="1" format="r0">${mediaRep('Broll.mov')}</asset>`, `
    <sequence format="r0" tcStart="3600s">
      <spine>
        <asset-clip ref="r1" offset="3600s" start="10s" duration="4s" name="Slow">
          <timeMap><timept time="0s" value="0s" interp="smooth2"/><timept time="20s" value="10s" interp="smooth2"/></timeMap>
        </asset-clip>
        <asset-clip ref="r1" offset="3604s" start="0s" duration="4s" name="Ramp">
          <timeMap><timept time="0s" value="20s"/><timept time="2s" value="22s"/><timept time="4s" value="28s"/></timeMap>
        </asset-clip>
        <asset-clip ref="r1" offset="3608s" start="0s" duration="2s" name="Reverse">
          <timeMap><timept time="0s" value="10s"/><timept time="10s" value="0s"/></timeMap>
        </asset-clip>
      </spine>
    </sequence>`);
  const { result, items } = await importFcpxml(xml, [{ id: 'broll', name: 'Broll.mov', kind: 'video', seconds: 60 }]);
  assert.deepEqual(items, [
    { asset: 'broll', track: 'Imported V1', start: 0, duration: 120, srcIn: 150, rate: 0.5 },
    { asset: 'broll', track: 'Imported V1', start: 120, duration: 120, srcIn: 600, rate: 2 },
  ]);
  assert.ok((result.warnings as string[]).some((warning) => /Ramp.*speed ramp approximated/.test(warning)));
  assert.deepEqual(reasons(result), ['asset-clip@01:00:08:00: reverse and freeze-frame retimes are not supported']);
}

// ── Multicam: active angle per mc-source, split video/audio angles ──
{
  const xml = document(`
    <format id="r1" frameDuration="1/25s" width="1920" height="1080"/>
    <asset id="rCam1" name="Cam 1" start="0s" duration="120s" hasVideo="1" hasAudio="1" format="r1">${mediaRep('Cam1.mov')}</asset>
    <asset id="rCam2" name="Cam 2" start="0s" duration="120s" hasVideo="1" hasAudio="1" format="r1">${mediaRep('Cam2.mov')}</asset>
    <media id="rMC" name="MC">
      <multicam format="r1" tcStart="0s">
        <mc-angle name="A" angleID="angA">
          <gap name="Gap" offset="0s" start="3600s" duration="2s"/>
          <asset-clip ref="rCam1" offset="2s" duration="100s" name="Cam 1"/>
        </mc-angle>
        <mc-angle name="B" angleID="angB">
          <asset-clip ref="rCam2" offset="0s" start="5s" duration="100s" name="Cam 2"/>
        </mc-angle>
      </multicam>
    </media>`, `
    <sequence format="r1" tcStart="3600s">
      <spine>
        <mc-clip ref="rMC" offset="3600s" name="MC" start="10s" duration="4s"><mc-source angleID="angA" srcEnable="all"/></mc-clip>
        <mc-clip ref="rMC" offset="3604s" name="MC" start="14s" duration="2s">
          <mc-source angleID="angA" srcEnable="video"/>
          <mc-source angleID="angB" srcEnable="audio"/>
        </mc-clip>
      </spine>
    </sequence>`);
  const { result, items } = await importFcpxml(xml, [
    { id: 'cam1', name: 'Cam1.mov', kind: 'video', seconds: 120 },
    { id: 'cam2', name: 'Cam2.mov', kind: 'video', seconds: 120 },
  ], 25);
  assert.deepEqual(items, [
    { asset: 'cam1', track: 'Imported V1', start: 0, duration: 100, srcIn: 200 },
    { asset: 'cam1', track: 'Imported V1', start: 100, duration: 50, srcIn: 300, muted: true },
  ]);
  assert.match(reasons(result).join('\n'), /asset-clip@01:00:04:00: audio of a video file that is not in sync/);
}

// ── Resolve per-clip assets: asset start/duration describe only the used range ──
{
  const xml = document(`
    <format id="r0" name="FFVideoFormat720x576p25" frameDuration="1/25s" width="720" height="576"/>
    <format id="r1" name="FFVideoFormat1080p2398" frameDuration="1001/24000s" width="1920" height="1080"/>
    <asset id="r1" name="input.mov" start="0/1s" duration="346/25s" hasVideo="1" format="r0"><media-rep kind="original-media" src="file:///Users/Per/Movies/Test/input.mov"/></asset>
    <asset id="r2" name="input.mov" start="346/25s" duration="56/5s" hasVideo="1" format="r0"><media-rep kind="original-media" src="file:///Users/Per/Movies/Test/input.mov"/></asset>
    <asset id="r9" name="AOA_CLIP_02.mov" start="173173/48s" duration="23023/2400s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file:///Volumes/Media/AOA_CLIP_02.mov"/></asset>`, `
    <sequence format="r0" tcStart="3600/1s" tcFormat="NDF">
      <spine>
        <asset-clip ref="r1" start="0/1s" duration="346/25s" offset="3600/1s" name="input.mov"/>
        <asset-clip ref="r2" start="346/25s" duration="56/5s" offset="90346/25s" name="input.mov"/>
        <asset-clip ref="r9" start="173173/48s" duration="23023/2400s" offset="90626/25s" name="AOA_CLIP_02.mov"/>
      </spine>
    </sequence>`);
  const { result, items } = await importFcpxml(xml, [
    { id: 'input', name: 'input.mov', kind: 'video', seconds: 38.44 },
    { id: 'aoa', name: 'AOA_CLIP_02.mov', kind: 'video', seconds: 20 },
  ], 25);
  assert.deepEqual(items, [
    { asset: 'input', track: 'Imported V1', start: 0, duration: 346, srcIn: 0 },
    // The file has no timecode: the in-point is the clip start itself, not start - asset start.
    { asset: 'input', track: 'Imported V1', start: 346, duration: 280, srcIn: 346 },
    // 01:00:04;04 on a clock assumed to start at 01:00:00:00 (23.976 NDF: 3603.6 s).
    { asset: 'aoa', track: 'Imported V1', start: 626, duration: 240, srcIn: 104 },
  ]);
  assert.deepEqual(result.warnings, [
    'input.mov (1 clip): assumed to have no embedded timecode, since the FCPXML describes only the ranges its clips use',
    'AOA_CLIP_02.mov (1 clip): embedded timecode assumed to start on the hour; set the asset\'s sourceTimecode (edit_asset) if it does not',
  ]);
  // Unprobed file: two assets with different ranges of one file still mark them as ranges.
  // A range that fits the file on neither clock is refused, not guessed.
  const unprobed = await importFcpxml(xml, [
    { id: 'input', name: 'input.mov', kind: 'video', durationInFrames: 0 },
    { id: 'aoa', name: 'AOA_CLIP_02.mov', kind: 'video', seconds: 12 },
  ], 25);
  assert.deepEqual(unprobed.items, [
    { asset: 'input', track: 'Imported V1', start: 0, duration: 346, srcIn: 0 },
    { asset: 'input', track: 'Imported V1', start: 346, duration: 280, srcIn: 346 },
  ]);
  assert.match(reasons(unprobed.result).join('\n'), /asset-clip@01:00:25:01: source timecode lies outside AOA_CLIP_02\.mov \(12s long\); set the asset's sourceTimecode/);
}

// ── Media matching: Resolve Windows URLs match the exact original path ──
{
  const xml = document(`
    <format id="r0" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="r2" start="0/1s" hasVideo="1" name="shot.png" duration="0/1s" format="r0"><media-rep src="file://localhost/C:/Users/joshn/Downloads/shot.png" kind="original-media"/></asset>`, `
    <sequence tcStart="3600/1s" format="r0">
      <spine><video offset="54001/15s" start="0/1s" name="shot.png" duration="61/30s" ref="r2"/></spine>
    </sequence>`);
  const { items } = await importFcpxml(xml, [
    { id: 'other', name: 'shot.png', kind: 'image', originalFilePath: 'D:\\Archive\\shot.png' },
    { id: 'shot', name: 'shot.png', kind: 'image', originalFilePath: 'C:\\Users\\joshn\\Downloads\\shot.png' },
  ]);
  assert.deepEqual(items, [{ asset: 'shot', track: 'Imported V1', start: 2, duration: 61, srcIn: 0 }]);
}

// ── Connected clips of different parents overlapping on one lane get an extra track ──
{
  const xml = document(`
    <format id="r0" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="rA" name="A.mov" start="0s" duration="60s" hasVideo="1" format="r0">${mediaRep('A.mov')}</asset>
    <asset id="rB" name="B.mov" start="0s" duration="60s" hasVideo="1" format="r0">${mediaRep('B.mov')}</asset>`, `
    <sequence format="r0" tcStart="0s">
      <spine>
        <asset-clip ref="rA" offset="0s" duration="4s" name="A">
          <asset-clip ref="rB" lane="1" offset="1s" duration="5s" name="Over A"/>
        </asset-clip>
        <asset-clip ref="rA" offset="4s" start="4s" duration="4s" name="A2">
          <asset-clip ref="rB" lane="1" offset="4s" start="10s" duration="2s" name="Over A2"/>
        </asset-clip>
      </spine>
    </sequence>`);
  const { result, items, order } = await importFcpxml(xml, [
    { id: 'a', name: 'A.mov', kind: 'video' },
    { id: 'b', name: 'B.mov', kind: 'video' },
  ]);
  assert.deepEqual(order, ['Imported V3', 'Imported V2', 'Imported V1']);
  assert.deepEqual(items, [
    { asset: 'a', track: 'Imported V1', start: 0, duration: 120, srcIn: 0 },
    { asset: 'a', track: 'Imported V1', start: 120, duration: 120, srcIn: 120 },
    { asset: 'b', track: 'Imported V2', start: 30, duration: 150, srcIn: 0 },
    // Overlaps "Over A" on lane 1: an extra track above it, not a shifted clip.
    { asset: 'b', track: 'Imported V3', start: 120, duration: 60, srcIn: 300 },
  ]);
  assert.match((result.warnings as string[]).join('\n'), /1 overlapping video clip\(s\) on one lane were placed on 1 extra track\(s\), starting with asset-clip "Over A2"/);
  assert.equal(result.skippedCount, 0);
}

// ── Nothing importable: the error lists why ──
{
  const { draft } = context([]);
  const parsed = await parseTimelineImport('fcpxml', document(`<effect id="t" name="Basic Title" uid="x"/><format id="r0" frameDuration="1/30s"/>`, `
    <sequence format="r0" tcStart="0s"><spine><title ref="t" offset="0s" duration="2s" name="Only a title"/></spine></sequence>`), [], draft.getState());
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.error, 'FCPXML sequence has no importable clips');
    assert.equal(parsed.skipped?.[0]?.reason, 'titles are not imported');
  }
}

console.log('timeline-import-fcpxml.verify: all assertions passed');
