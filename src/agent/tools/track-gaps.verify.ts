// Runnable check: `npx tsx src/agent/tools/track-gaps.verify.ts`.
// Verify the track holes reported by read_project: only holes between fragments are reported (blank spaces at the beginning and end are not counted), overlapping holes are not counted.
// Isolate by track, and input out of order must also be correct. The holes on the main video track are exported as black frames, so they are worth reporting proactively.
import assert from 'node:assert/strict';
import { execReadProjectTool, trackGaps } from './read-project-tools';
import type { TimelineItem } from '../../editor/types';

const clip = (id: string, startFrame: number, durationInFrames: number, track = 'V1'): TimelineItem => ({
  id, track, startFrame, durationInFrames, kind: 'video', name: id, src: '/m/a.mp4',
} as TimelineItem);

// ── Basic: The holes between the segments are reported, and the beginning and end are left blank ──
{
  const items = [clip('a', 100, 50), clip('b', 200, 50), clip('c', 400, 50)];
  assert.deepEqual(trackGaps(items, 'V1'), [
    { fromFrame: 150, toFrame: 200 },
    { fromFrame: 250, toFrame: 400 },
  ], '开头的 0..100 不算洞——那只是轨道还没开始');
}

// ── end to end / empty track / single clip → no holes ──
{
  assert.deepEqual(trackGaps([clip('a', 0, 60), clip('b', 60, 60)], 'V1'), []);
  assert.deepEqual(trackGaps([], 'V1'), []);
  assert.deepEqual(trackGaps([clip('a', 300, 60)], 'V1'), [], '单个片段前面的留白不是洞');
}

// ── Overlaps are not holes; neither are intervals completely covered by long segments ──
{
  assert.deepEqual(trackGaps([clip('a', 0, 100), clip('b', 50, 100)], 'V1'), []);
  assert.deepEqual(
    trackGaps([clip('long', 0, 500), clip('mid', 100, 50), clip('after', 600, 50)], 'V1'),
    [{ fromFrame: 500, toFrame: 600 }],
    '嵌在长片段里的短片段不制造洞,链尾按最大右边缘算',
  );
}

// ── Even if the input order is out of order ──
{
  const shuffled = [clip('c', 400, 50), clip('a', 100, 50), clip('b', 200, 50)];
  assert.deepEqual(trackGaps(shuffled, 'V1'), [
    { fromFrame: 150, toFrame: 200 },
    { fromFrame: 250, toFrame: 400 },
  ]);
}

// ── Isolate by track: clips from other tracks cannot fill the holes in this track ──
{
  const items = [clip('a', 0, 50), clip('b', 200, 50), clip('other', 50, 150, 'V2')];
  assert.deepEqual(trackGaps(items, 'V1'), [{ fromFrame: 50, toFrame: 200 }]);
  assert.deepEqual(trackGaps(items, 'V2'), []);
  assert.deepEqual(trackGaps(items, 'A1'), [], '不存在的轨没有洞');
}

// ── read_project exposes the local offline status to assets and timeline clips at the same time ──
{
  const src = '/media/uploads/missing.mp4';
  const timeline = {
    id: 'tl', name: 'Timeline', order: 0, fps: 30, width: 1920, height: 1080,
    items: [{ ...clip('offline', 0, 30), src }],
    trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
  };
  const doc = {
    version: 3, activeTimelineId: 'tl', timelines: [timeline], mediaFolders: [],
    assets: [{ id: 'asset-offline', name: 'missing.mp4', kind: 'video', src, durationInFrames: 30 }],
  };
  const result = await execReadProjectTool('read_project', {}, {
    getState: () => timeline,
    getDoc: () => doc,
    getOfflineMediaSrcs: () => new Set([src]),
    getProjectId: () => 'project',
  } as never) as {
    timeline: { items: Array<{ offline: boolean }> };
    mediaPool: { assets: Array<{ offline: boolean }>; offlineAssetCount: number };
  };
  assert.equal(result.timeline.items[0]?.offline, true);
  assert.equal(result.mediaPool.assets[0]?.offline, true);
  assert.equal(result.mediaPool.offlineAssetCount, 1);
}

console.log('track-gaps.verify: ok (洞/首尾不算/重叠与包含/乱序/按轨隔离/离线状态)');
