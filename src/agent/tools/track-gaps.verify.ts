// Runnable check: `npx tsx src/agent/tools/track-gaps.verify.ts`.
// 验证 read_project 报出的轨道空洞:只报片段之间的洞(首尾留白不算),重叠不算洞,
// 按轨隔离,乱序输入也要对。主视频轨上的洞导出就是黑帧,所以值得主动报。
import assert from 'node:assert/strict';
import { execReadProjectTool, trackGaps } from './read-project-tools';
import type { TimelineItem } from '../../editor/types';

const clip = (id: string, startFrame: number, durationInFrames: number, track = 'V1'): TimelineItem => ({
  id, track, startFrame, durationInFrames, kind: 'video', name: id, src: '/m/a.mp4',
} as TimelineItem);

// ── 基本:片段之间的洞报出来,首尾留白不报 ──
{
  const items = [clip('a', 100, 50), clip('b', 200, 50), clip('c', 400, 50)];
  assert.deepEqual(trackGaps(items, 'V1'), [
    { fromFrame: 150, toFrame: 200 },
    { fromFrame: 250, toFrame: 400 },
  ], '开头的 0..100 不算洞——那只是轨道还没开始');
}

// ── 首尾相接 / 空轨 / 单个片段 → 没有洞 ──
{
  assert.deepEqual(trackGaps([clip('a', 0, 60), clip('b', 60, 60)], 'V1'), []);
  assert.deepEqual(trackGaps([], 'V1'), []);
  assert.deepEqual(trackGaps([clip('a', 300, 60)], 'V1'), [], '单个片段前面的留白不是洞');
}

// ── 重叠不是洞;被长片段完全覆盖的区间也不是 ──
{
  assert.deepEqual(trackGaps([clip('a', 0, 100), clip('b', 50, 100)], 'V1'), []);
  assert.deepEqual(
    trackGaps([clip('long', 0, 500), clip('mid', 100, 50), clip('after', 600, 50)], 'V1'),
    [{ fromFrame: 500, toFrame: 600 }],
    '嵌在长片段里的短片段不制造洞,链尾按最大右边缘算',
  );
}

// ── 输入乱序也要对 ──
{
  const shuffled = [clip('c', 400, 50), clip('a', 100, 50), clip('b', 200, 50)];
  assert.deepEqual(trackGaps(shuffled, 'V1'), [
    { fromFrame: 150, toFrame: 200 },
    { fromFrame: 250, toFrame: 400 },
  ]);
}

// ── 按轨隔离:别的轨的片段不能填上这条轨的洞 ──
{
  const items = [clip('a', 0, 50), clip('b', 200, 50), clip('other', 50, 150, 'V2')];
  assert.deepEqual(trackGaps(items, 'V1'), [{ fromFrame: 50, toFrame: 200 }]);
  assert.deepEqual(trackGaps(items, 'V2'), []);
  assert.deepEqual(trackGaps(items, 'A1'), [], '不存在的轨没有洞');
}

// ── read_project 把本机离线状态同时暴露给素材与时间线片段 ──
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
