import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execTimelineImportTool, parseTimelineImport } from './timeline-import-tools';

function context() {
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
  });
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
  assert.equal(draft.getDoc().activeTimelineId, originalTimelineId, 'activate=false keeps the current timeline selected');
  const imported = draft.getDoc().timelines.find((timeline) => timeline.id === result.timelineId)!;
  assert.equal(imported.name, 'FCP Import');
  assert.equal(imported.fps, 25);
  assert.equal(imported.width, 1920);
  assert.equal(imported.items.length, 1);
  assert.deepEqual(
    {
      sourceAssetId: imported.items[0]!.sourceAssetId,
      startFrame: imported.items[0]!.startFrame,
      durationInFrames: imported.items[0]!.durationInFrames,
      srcInFrame: imported.items[0]!.srcInFrame,
    },
    { sourceAssetId: 'video-asset', startFrame: 25, durationInFrames: 75, srcInFrame: 50 },
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
  const parsed = await parseTimelineImport('edl', dropFrame, draft.getDoc().assets, draft.getState());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.timeline.clips[0]!.sourceStartFrame, 1800);
    assert.equal(parsed.timeline.clips[0]!.durationInFrames, 30);
  }
}

console.log('timeline-import-tools.verify: all assertions passed');
