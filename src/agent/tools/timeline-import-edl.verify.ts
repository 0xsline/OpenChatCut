// CMX 3600 EDL import timing (#106): events are placed from the record start
// (01:00:00:00 on DaVinci Resolve / Avid timelines), source timecode is read on
// each file's own clock, and drop-frame follows FCM / ';'. Layouts follow real
// exports: DaVinci Resolve 16 (ctsrc/ffmpeg-extract-clips-davinci-resolve-edl
// README), Premiere Pro (V + A + A2 events per clip, dissolves as a repeated
// event number) and the OpenTimelineIO cmx_3600 adapter samples.
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
    doc.assets.push({ src: `/media/uploads/${entry.id}`, durationInFrames: Math.round((seconds ?? 60) * fps), ...entry } as MediaAsset);
  }
  const draft = makeDraft(doc);
  const ctx = {
    commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
    getCreativeMode: () => null, templates: [], audio: [],
  } as AgentContext;
  return { draft, ctx };
}

async function importEdl(content: string, pool: PoolEntry[], options: Record<string, unknown> = {}, fps = 30) {
  const { draft, ctx } = context(pool, fps);
  const result = await execTimelineImportTool('import_timeline', { format: 'edl', content, ...options }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const timeline = draft.getDoc().timelines.find((item) => item.id === result.timelineId)!;
  const items = timeline.items
    .map((item: TimelineItem) => ({
      asset: item.sourceAssetId,
      track: timeline.tracks?.[item.track]?.name ?? item.track,
      start: item.startFrame,
      duration: item.durationInFrames,
      srcIn: item.srcInFrame ?? 0,
      ...(item.playbackRate !== undefined ? { rate: item.playbackRate } : {}),
    }))
    .sort((left, right) => left.track.localeCompare(right.track) || left.start - right.start);
  return { result, timeline, items };
}

const skippedOf = (result: Record<string, unknown>) => (result.skipped as Array<{ element: string; at?: string; reason: string }>)
  .map((entry) => `${entry.element}@${entry.at ?? '?'}: ${entry.reason}`);

// ── DaVinci Resolve 16 export: record timecode starts at 01:00:00:00 ──
{
  const edl = `TITLE: Timeline 1
FCM: NON-DROP FRAME

001  AX       V     C        00:00:00:00 00:00:01:24 01:00:00:00 01:00:01:24
* FROM CLIP NAME: IMG_2926.TRIM.mov
002  AX       V     C        00:00:01:24 00:00:02:02 01:00:01:24 01:00:02:02
* FROM CLIP NAME: IMG_2926.TRIM.mov
003  AX       V     C        00:00:02:02 00:00:02:18 01:00:02:02 01:00:02:18
* FROM CLIP NAME: IMG_2926.TRIM.mov
`;
  const { result, items } = await importEdl(edl, [{ id: 'img', name: 'IMG_2926.TRIM.mov', kind: 'video', seconds: 10 }]);
  assert.equal(result.startTimecode, '01:00:00:00');
  assert.deepEqual(items, [
    { asset: 'img', track: 'Imported V1', start: 0, duration: 54, srcIn: 0 },
    { asset: 'img', track: 'Imported V1', start: 54, duration: 8, srcIn: 54 },
    { asset: 'img', track: 'Imported V1', start: 62, duration: 16, srcIn: 62 },
  ]);
}

// ── Premiere-style list at 25 fps: black, V + A + A2 of one clip, a dissolve, a stereo music bed ──
{
  const edl = `TITLE: Sequence 01
FCM: NON-DROP FRAME

001  BL       V     C        00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00
002  AX       V     C        00:00:10:00 00:00:14:00 01:00:02:00 01:00:06:00
* FROM CLIP NAME: Interview.mov
003  AX       A     C        00:00:10:00 00:00:14:00 01:00:02:00 01:00:06:00
* FROM CLIP NAME: Interview.mov
004  AX       A2    C        00:00:10:00 00:00:14:00 01:00:02:00 01:00:06:00
* FROM CLIP NAME: Interview.mov
005  AX       V     C        00:00:14:00 00:00:14:00 01:00:06:00 01:00:06:00
005  AX       V     D    025 00:00:20:00 00:00:24:00 01:00:06:00 01:00:10:00
* FROM CLIP NAME: Interview.mov
* TO CLIP NAME: Broll.mov
006  AX       AA    C        00:00:00:00 00:00:08:00 01:00:02:00 01:00:10:00
* FROM CLIP NAME: score.wav
`;
  const { result, items, timeline } = await importEdl(edl, [
    { id: 'interview', name: 'Interview.mov', kind: 'video', seconds: 60 },
    { id: 'broll', name: 'Broll.mov', kind: 'video', seconds: 60 },
    { id: 'score', name: 'score.wav', kind: 'audio', seconds: 180 },
  ], { fps: 25 });
  // Read at the fps argument, placed at the 30 fps project's rate (#184).
  assert.equal(timeline.fps, 30, 'the imported timeline runs at the project rate');
  assert.equal((result.warnings as string[])[0], 'the 25 fps list was converted to the project frame rate (30 fps); cut points are rounded to the nearest frame');
  assert.deepEqual(items, [
    // AA on one audio file is one clip, not two.
    { asset: 'score', track: 'Imported A1', start: 60, duration: 240, srcIn: 0 },
    // A and A2 of the video file are carried by its video clip.
    { asset: 'interview', track: 'Imported V1', start: 60, duration: 120, srcIn: 300 },
    // The dissolve's incoming clip starts at the transition; TO CLIP NAME names it.
    { asset: 'broll', track: 'Imported V1', start: 180, duration: 120, srcIn: 600 },
  ]);
  assert.deepEqual(skippedOf(result), ['event 005@01:00:06:00: dissolve transition is not imported; the clips meet with a cut']);
  assert.ok((result.warnings as string[]).some((warning) => /2 audio component\(s\) of video files were merged/.test(warning)));
}

// ── Drop-frame 29.97: ';' labels, FCM, and CMX-style ':' labels under FCM: DROP FRAME ──
for (const separator of [';', ':']) {
  const tc = (label: string) => label.replace(/;/g, separator);
  const edl = `TITLE: DF Test
FCM: DROP FRAME
001  AX  V  C  ${tc('00:00:59;28 00:01:00;04 01:00:00;00 01:00:00;04')}
* FROM CLIP NAME: clip.mp4
002  AX  V  C  ${tc('00:10:00;00 00:10:00;10 01:00:00;04 01:00:00;14')}
* FROM CLIP NAME: clip.mp4
`;
  // A 29.97 project keeps the list's frames, so the drop-frame arithmetic shows.
  const { result, items, timeline } = await importEdl(edl, [{ id: 'clip', name: 'clip.mp4', kind: 'video', seconds: 660 }], {}, 30000 / 1001);
  assert.equal(timeline.fps, 30000 / 1001, 'drop-frame lists are 29.97');
  assert.deepEqual(result.warnings, [], 'nothing to convert');
  assert.equal(result.startTimecode, '01:00:00;00');
  assert.deepEqual(items, [
    // 00:00:59;28 → 00:01:00;04 is four frames: ;00 and ;01 of minute 1 do not exist.
    { asset: 'clip', track: 'Imported V1', start: 0, duration: 4, srcIn: 1798 },
    { asset: 'clip', track: 'Imported V1', start: 4, duration: 10, srcIn: 17982 },
  ], `separator ${separator}`);
}

// ── Source timecode on each file's own clock ──
{
  const edl = `TITLE: Camera TC
FCM: NON-DROP FRAME
001  A001  V  C  14:00:05:00 14:00:07:00 01:00:00:00 01:00:02:00
* FROM CLIP NAME: A001C001.mov
002  B002  V  C  01:00:05:00 01:00:06:00 01:00:02:00 01:00:03:00
* FROM CLIP NAME: B002C001.mov
003  C003  V  C  15:30:00:00 15:30:01:00 01:00:03:00 01:00:04:00
* FROM CLIP NAME: C003C001.mov
`;
  const { result, items } = await importEdl(edl, [
    {
      id: 'a', name: 'A001C001.mov', kind: 'video', seconds: 60,
      sourceTimecode: { frameCount: 14 * 3600 * 25, frameRate: { numerator: 25, denominator: 1 }, dropFrame: false },
    },
    { id: 'b', name: 'B002C001.mov', kind: 'video', seconds: 60 },
    { id: 'c', name: 'C003C001.mov', kind: 'video', seconds: 60 },
  ], { fps: 25 }, 25);
  assert.deepEqual(items, [
    // Embedded timecode 14:00:00:00 recorded on the pool asset.
    { asset: 'a', track: 'Imported V1', start: 0, duration: 50, srcIn: 125 },
    // No recorded timecode: a clock starting on the hour keeps the event inside the file.
    { asset: 'b', track: 'Imported V1', start: 50, duration: 25, srcIn: 125 },
  ]);
  assert.match((result.warnings as string[]).join('\n'), /B002C001\.mov \(1 clip\): embedded timecode assumed to start on the hour/);
  assert.match(skippedOf(result).join('\n'), /event 003@01:00:03:00: source timecode lies outside C003C001\.mov .*sourceTimecode/);
}

// ── Record start: hour boundary within a minute, else the first record-in, or startTimecode ──
{
  const pool: PoolEntry[] = [
    { id: 'take1', name: 'take_1.mov', kind: 'video', seconds: 60 },
    { id: 'take2', name: 'take_2.mov', kind: 'video', seconds: 60 },
  ];
  const headOfBlack = `TITLE: Lead In
001  AX  V  C  00:00:01:00 00:00:03:00 01:00:10:00 01:00:12:00
* FROM CLIP NAME: take_1.mov
`;
  const lead = await importEdl(headOfBlack, pool, { fps: 25 }, 25);
  assert.equal(lead.result.startTimecode, '01:00:00:00');
  assert.deepEqual(lead.items, [{ asset: 'take1', track: 'Imported V1', start: 250, duration: 50, srcIn: 25 }]);
  const override = await importEdl(headOfBlack, pool, { fps: 25, startTimecode: '00:59:50:00' }, 25);
  assert.equal(override.items[0]!.start, 500, 'startTimecode 00:59:50:00 puts 01:00:10:00 at 20 s');
  // OpenTimelineIO's Premiere sample: a 24 fps list that starts at 00:59:53:11.
  const premiere = `TITLE:   Premiere_Example.01
001  AX V     C        01:00:04:05 01:00:05:12 00:59:53:11 00:59:54:18
* FROM CLIP NAME:  take_1.mov
002  AX V     C        01:00:06:13 01:00:08:15 00:59:54:18 00:59:56:20
* FROM CLIP NAME:  take_2.mov
`;
  const early = await importEdl(premiere, pool, { fps: 24 }, 24);
  assert.equal(early.result.startTimecode, '00:59:53:11');
  assert.deepEqual(early.items, [
    { asset: 'take1', track: 'Imported V1', start: 0, duration: 31, srcIn: 101 },
    { asset: 'take2', track: 'Imported V1', start: 31, duration: 50, srcIn: 157 },
  ]);
  // One assumption, reported once for the whole list rather than per event.
  assert.deepEqual(early.result.warnings, [
    'take_1.mov, take_2.mov (2 clips): embedded timecode assumed to start on the hour; set the asset\'s sourceTimecode (edit_asset) if it does not',
  ]);
  // A 25 fps list read at 24 fps names the frame rate to pass.
  const { ctx } = context(pool, 24);
  const wrongRate = await execTimelineImportTool('import_timeline', {
    format: 'edl',
    content: '001  AX  V  C  00:00:01:24 00:00:02:00 01:00:00:00 01:00:00:01\n* FROM CLIP NAME: take_1.mov\n',
  }, ctx);
  assert.equal(wrongRate.ok, false);
  assert.match(skippedOf(wrongRate).join('\n'), /event 001@01:00:00:00: timecode does not exist at 24 fps; pass the list's frame rate as fps/);
}

// ── Speed (M2), unknown lines and invalid rates are reported, not guessed ──
{
  const edl = `TITLE: Effects
FCM: NON-DROP FRAME
001  AX  V  C  00:00:10:00 00:00:14:00 01:00:00:00 01:00:02:00
M2   AX       050.0                00:00:10:00
* FROM CLIP NAME: take_1.mov
002  AX  V  C  00:00:20:00 00:00:20:01 01:00:02:00 01:00:03:00
M2   AX       000.0                00:00:20:00
* FROM CLIP NAME: take_1.mov
003  AX  VX  C  00:00:30:00 00:00:31:00 01:00:03:00 01:00:04:00
* FROM CLIP NAME: take_1.mov
`;
  const { result, items } = await importEdl(edl, [{ id: 'take1', name: 'take_1.mov', kind: 'video', seconds: 60 }], { fps: 25 }, 25);
  assert.deepEqual(items, [{ asset: 'take1', track: 'Imported V1', start: 0, duration: 50, srcIn: 250, rate: 2 }]);
  assert.deepEqual(skippedOf(result), [
    'event 002@01:00:02:00: freeze frames are not imported',
    'event 003@01:00:03:00: unknown channel "VX"',
  ]);
  const { draft } = context([]);
  const invalid = await parseTimelineImport('edl', '001  AX  V  C  00:00:00;00 00:00:01;00 01:00:00;00 01:00:01;00', [], draft.getState(), { fps: 25 });
  assert.deepEqual(invalid, { ok: false, error: 'drop-frame timecode requires 29.97 or 59.94 fps, not 25' });
}

// ── Fade from black names its clip with FROM CLIP NAME; missing media aborts with the event number ──
{
  const edl = `TITLE: Fade
FCM: NON-DROP FRAME
001  BL       V     C        00:00:00:00 00:00:00:00 01:00:00:00 01:00:00:00
001  AX       V     D    025 00:00:05:00 00:00:09:00 01:00:00:00 01:00:04:00
* FROM CLIP NAME: take_1.mov
002  AX       V     C        00:00:00:00 00:00:01:00 01:00:04:00 01:00:05:00
* FROM CLIP NAME: pickup.mov
`;
  const take: PoolEntry = { id: 'take1', name: 'take_1.mov', kind: 'video', seconds: 60 };
  const { draft } = context([take]);
  const before = draft.getDoc();
  const missing = await parseTimelineImport('edl', edl, draft.getDoc().assets, draft.getState(), { fps: 25 });
  assert.deepEqual(missing, {
    ok: false,
    error: 'EDL media references are unresolved',
    unresolved: [{ reference: 'event 002: pickup.mov', reason: 'no matching media-pool asset' }],
  });
  assert.equal(draft.getDoc(), before, 'an unresolved list changes nothing');
  const { result, items } = await importEdl(edl, [take, { id: 'pickup', name: 'pickup.mov', kind: 'video', seconds: 10 }], { fps: 25 }, 25);
  assert.deepEqual(items, [
    { asset: 'take1', track: 'Imported V1', start: 0, duration: 100, srcIn: 125 },
    { asset: 'pickup', track: 'Imported V1', start: 100, duration: 25, srcIn: 0 },
  ]);
  assert.deepEqual(skippedOf(result), ['event 001@01:00:00:00: dissolve transition is not imported; the clips meet with a cut']);
}

console.log('timeline-import-edl.verify: all assertions passed');
