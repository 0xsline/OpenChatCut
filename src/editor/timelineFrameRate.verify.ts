// Issue #175: the GUI could only create 30 fps timelines. The project frame
// rate is now chosen in the timeline toolbar, before anything is placed.
// Run: npx tsx src/editor/timelineFrameRate.verify.ts
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { nearestExportFps } from '../export/mediaSettings';
import { historyReduce, projectReduce } from './reduce';
import { makeDraft } from './store';
import {
  FRAME_RATE_LOCKED_REASON,
  projectFrameRateLock,
  TIMELINE_FPS_OPTIONS,
  withProjectFrameRate,
} from './timelineFrameRate';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from './types';

const timeline = (id: string, patch: Partial<Timeline> = {}): Timeline => ({
  id,
  name: id,
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [],
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
  ...patch,
});
const asset = (id: string, kind: MediaAsset['kind'], durationInFrames: number): MediaAsset => ({
  id, name: id, kind, src: `/media/uploads/${id}`, durationInFrames,
});
const project = (timelines: Timeline[], assets: MediaAsset[] = []): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION,
  assets,
  mediaFolders: [],
  timelines,
  activeTimelineId: timelines[0]!.id,
});
const clip: TimelineItem = {
  id: 'clip', track: 'track_v1', startFrame: 0, durationInFrames: 300, name: 'clip', kind: 'solid', props: { color: '#000' },
};

assert.deepEqual([...TIMELINE_FPS_OPTIONS], [24, 25, 30, 50, 60], 'only rates every export route renders natively');

// A new project picks its rate before any media is placed.
const blank = project([timeline('tl_1')]);
assert.equal(projectFrameRateLock(blank), null);
const sixty = projectReduce(blank, { type: 'tl.setFps', fps: 60 });
assert.equal(sixty.timelines[0]!.fps, 60);

// Every sequence moves together, and pool durations keep their seconds.
const pooled = project([timeline('tl_1'), timeline('tl_2', { order: 1 })], [
  asset('footage', 'video', 300),
  asset('still', 'image', 150),
  asset('voice', 'audio', 45),
  asset('graphic', 'motion-graphic', 150),
  asset('brief', 'document', 1),
]);
const pooled60 = projectReduce(pooled, { type: 'tl.setFps', fps: 60 });
assert.deepEqual(pooled60.timelines.map((item) => item.fps), [60, 60]);
assert.deepEqual(pooled60.assets.map((item) => item.durationInFrames), [600, 300, 90, 150, 1],
  '10 s of 30 fps footage is 600 frames at 60 fps; authored motion graphics keep their frames');
const pooled24 = projectReduce(pooled, { type: 'tl.setFps', fps: 24 });
assert.deepEqual(pooled24.assets.map((item) => item.durationInFrames), [240, 120, 36, 150, 1]);
assert.equal(pooled.assets[0]!.durationInFrames, 300, 'the previous document is not mutated');

// Anything already placed is counted in the current rate, so the rate locks.
const locked: ProjectDoc[] = [
  project([timeline('tl_1', { items: [clip] })]),
  project([timeline('tl_1'), timeline('tl_2', { order: 1, items: [clip] })]),
  project([timeline('tl_1', { markers: [{ id: 'm', scope: 'project', fromFrame: 30, durationFrames: 0, note: '', color: 'red' }] })]),
  project([timeline('tl_1', {
    trackOrder: ['track_v1', 'track_c1'],
    tracks: { track_v1: { kind: 'video' }, track_c1: { kind: 'caption', captions: { enabled: true } as never } },
  })]),
];
for (const doc of locked) {
  assert.equal(projectFrameRateLock(doc), FRAME_RATE_LOCKED_REASON);
  assert.equal(projectReduce(doc, { type: 'tl.setFps', fps: 60 }), doc, 'a locked project keeps its rate');
}

// Only offered rates; a no-op change leaves the document (and history) alone.
for (const fps of [59.94, 29.97, 120, 0, -30, Number.NaN]) {
  assert.equal(withProjectFrameRate(blank, fps), blank, `${fps} fps is not offered`);
}
assert.equal(projectReduce(blank, { type: 'tl.setFps', fps: 30 }), blank);

// Undoable like any other project edit.
const history = historyReduce({ past: [], present: blank, future: [] }, { type: 'tl.setFps', fps: 50 });
assert.equal(history.present.timelines[0]!.fps, 50);
assert.equal(historyReduce(history, { type: 'undo' }).present.timelines[0]!.fps, 30);

// The command the toolbar calls dispatches the same action.
const draft = makeDraft(blank);
draft.commands.setProjectFps(25);
assert.equal(draft.getDoc().timelines[0]!.fps, 25);
assert.deepEqual(draft.takeActions(), [{ type: 'tl.setFps', fps: 25 }]);

// "+ Sequence" inherits the project rate.
const withSequence = makeDraft(sixty);
withSequence.commands.createTimeline();
assert.deepEqual(withSequence.getDoc().timelines.map((item) => item.fps), [60, 60]);

// The export dialog starts at the export rate nearest the timeline's own.
assert.equal(nearestExportFps(60), 60);
assert.equal(nearestExportFps(60000 / 1001), 60, '59.94 exports at 60, not the old 30 default');
assert.equal(nearestExportFps(30000 / 1001), 30);
assert.equal(nearestExportFps(24000 / 1001), 24);
assert.equal(nearestExportFps(25), 25);
assert.equal(nearestExportFps(48), 50);
assert.equal(nearestExportFps(55), 60, 'ties go to the higher rate');
assert.equal(nearestExportFps(120), 60);
assert.equal(nearestExportFps(Number.NaN), 30);

console.log('timelineFrameRate.verify: project frame rate changes before placement, locks after, and stays undoable');
