// Issue #184: a 6 s clip imported into a 30 fps project read 0:08 in the media
// pool once a 24 fps sequence was active. Pool durations are frame counts at the
// project rate, so every sequence has to run at that one rate. import_timeline
// used to create its timeline at the FCPXML/EDL rate, and an agent's new
// sequence that landed after the user picked another rate kept the old one.
// Run: npx tsx src/editor/projectFrameRate.verify.ts
import assert from 'node:assert/strict';
import type { AgentContext } from '../agent/context';
import { execTimelineImportTool } from '../agent/tools/timeline-import-tools';
import { durationLabel } from '../media/mediaPoolFormat';
import { docFromTimeline } from '../persist/projectStore';
import { projectReduce } from './reduce';
import { makeDraft, replayActions } from './store';
import { activeTimeline, type MediaAsset, type ProjectDoc } from './types';

const clip: MediaAsset = {
  id: 'clip', name: 'clip.mp4', kind: 'video', src: '/media/uploads/clip.mp4',
  originalFilePath: '/Users/test/clip.mp4', durationInFrames: 6 * 30,
};

function project(): ProjectDoc {
  const doc = docFromTimeline({
    fps: 30, width: 1920, height: 1080, selectedId: null, trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, items: [],
  });
  return { ...doc, assets: [clip] };
}

/** The media card's duration: the pool frames read at the active sequence's rate (MediaPoolCard). */
const cardLabel = (doc: ProjectDoc) => durationLabel(doc.assets[0]!.durationInFrames, activeTimeline(doc).fps);
const rates = (doc: ProjectDoc) => [...new Set(doc.timelines.map((timeline) => timeline.fps))];

async function importTimeline(doc: ProjectDoc, args: Record<string, unknown>) {
  const draft = makeDraft(doc);
  const ctx = {
    commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
    getCreativeMode: () => null, templates: [], audio: [],
  } as AgentContext;
  const result = await execTimelineImportTool('import_timeline', args, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { doc: draft.getDoc(), result };
}

/** The whole clip, cut in a sequence at `fps`. */
const fcpxml = (fps: number) => `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10"><resources>
  <format id="r1" frameDuration="1/${fps}s" width="1920" height="1080"/>
  <asset id="r2" name="clip.mp4" start="0s" duration="6s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file:///Users/test/clip.mp4"/></asset>
</resources><library><event><project name="${fps} fps cut"><sequence format="r1" tcStart="0s"><spine>
  <asset-clip ref="r2" name="clip.mp4" offset="0s" start="0s" duration="6s"/>
</spine></sequence></project></event></library></fcpxml>`;

const edl = `TITLE: 24 fps cut
FCM: NON-DROP FRAME
001  AX  V  C  00:00:00:00 00:00:06:00 01:00:00:00 01:00:06:00
* FROM CLIP NAME: clip.mp4
`;

// ── import_timeline: 24, 30 and 60 fps sequences join the 30 fps project ──
{
  let doc = project();
  for (const fps of [24, 30, 60]) {
    const imported = await importTimeline(doc, { format: 'fcpxml', content: fcpxml(fps) });
    doc = imported.doc;
    assert.equal(cardLabel(doc), '0:06', `the card still reads 0:06 with the ${fps} fps import active`);
    assert.deepEqual(rates(doc), [30], `a ${fps} fps sequence runs at the project rate`);
    assert.equal(imported.result.fps, 30);
    const timeline = doc.timelines.find((item) => item.id === imported.result.timelineId)!;
    const [item] = timeline.items;
    assert.deepEqual(
      { start: item!.startFrame, duration: item!.durationInFrames, srcIn: item!.srcInFrame ?? 0 },
      { start: 0, duration: 180, srcIn: 0 },
      'the whole 6 s clip, counted in project frames',
    );
  }
  assert.equal(doc.timelines.length, 4);
  for (const timeline of doc.timelines) {
    assert.equal(cardLabel(projectReduce(doc, { type: 'tl.switch', id: timeline.id })), '0:06',
      `switching to ${timeline.name} keeps 0:06`);
  }
  const fromEdl = await importTimeline(project(), { format: 'edl', content: edl, fps: 24 });
  assert.equal(cardLabel(fromEdl.doc), '0:06');
  assert.deepEqual(rates(fromEdl.doc), [30], 'a 24 fps EDL runs at the project rate');
  assert.equal(fromEdl.doc.timelines.at(-1)!.items[0]!.durationInFrames, 180);
}

// ── An agent's new sequence lands after the user picked 24 fps: it joins at 24 ──
{
  const base = project();
  const agent = makeDraft(base);
  agent.commands.createTimeline({ name: 'Agent sequence' });
  const recorded = agent.takeActions();
  const live = projectReduce(base, { type: 'tl.setFps', fps: 24 });
  assert.equal(cardLabel(live), '0:06', 'the rate change recounts the pool');
  const landed = replayActions(live, recorded);
  assert.equal(landed.timelines.length, 2);
  assert.deepEqual(rates(landed), [24], 'the replayed sequence adopts the rate the project has now');
  assert.equal(cardLabel(landed), '0:06');
}

// ── The acceptance from the issue: switching the project among 24, 60 and 30 fps ──
{
  let doc = project();
  for (const fps of [24, 60, 30]) {
    doc = projectReduce(doc, { type: 'tl.setFps', fps });
    assert.deepEqual(rates(doc), [fps]);
    assert.equal(cardLabel(doc), '0:06', `${fps} fps`);
  }
}

console.log('projectFrameRate.verify: every sequence runs at the project rate and the media card keeps 0:06');
