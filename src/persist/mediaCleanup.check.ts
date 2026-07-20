// 素材清理纯逻辑检查:引用做差、级联删的独占判定语义(经内存态 projectStore 走真流程)。
// 跑法:npx tsx src/persist/mediaCleanup.check.ts(已入 npm test 链)。
import assert from 'node:assert/strict';
import { collectAllUploadRefs, unreferencedOf } from './mediaCleanup';
import { createProject, listProjectDocIds, purgeProject } from './projectStore';
import type { ProjectDoc } from '../editor/types';

// ── unreferencedOf:盘面 − 引用 ──────────────────────────────────────────
{
  const files = [
    { name: 'a.mp4', bytes: 10, mtimeMs: 1 },
    { name: '李白_01_开篇.mp3', bytes: 20, mtimeMs: 2 },
    { name: 'kept.png', bytes: 30, mtimeMs: 3 },
  ];
  const refs = new Set(['/media/uploads/kept.png']);
  const orphans = unreferencedOf(files, refs);
  assert.deepEqual(orphans.map((f) => f.name), ['a.mp4', '李白_01_开篇.mp3'], '引用的不进无主清单(中文名照常)');
  console.log('unreferencedOf: OK');
}

// ── 引用并集 + 独占判定(内存态 projectStore) ────────────────────────────
{
  const doc = (src: string): ProjectDoc => ({
    version: 2,
    assets: [{ id: 'a1', name: 'x', kind: 'video', src, durationInFrames: 30 }],
    mediaFolders: [],
    timelines: [{ id: 'tl1', name: '序列 1', fps: 30, width: 1920, height: 1080, selectedId: null, items: [] } as never],
    activeTimelineId: 'tl1',
  } as never);
  const shared = '/media/uploads/shared.mp4';
  const solo = '/media/uploads/solo.mp4';
  const p1 = await createProject('甲', doc(shared));
  const p2 = await createProject('乙', doc(shared));
  const p3 = await createProject('丙', doc(solo));

  let refs = await collectAllUploadRefs();
  assert.ok(refs.has(shared) && refs.has(solo), '并集含全部引用');

  // 排除 p3 后 solo 无人引用 → 级联删应删;shared 因 p2 仍在 → 保
  refs = await collectAllUploadRefs(p3.id);
  assert.ok(!refs.has(solo) && refs.has(shared), '排除自身后:独占的裸奔,共享的仍被护住');

  // 删掉 p1 后 shared 仍被 p2 引用
  await purgeProject(p1.id);
  refs = await collectAllUploadRefs();
  assert.ok(refs.has(shared), '复制体在,共享素材引用不丢');

  for (const m of [p2, p3]) await purgeProject(m.id);
  assert.equal((await listProjectDocIds()).length, 0, 'purge 后文档清零');
  console.log('collectAllUploadRefs/级联语义: OK');
}

console.log('\nmediaCleanup.check: ALL PASSED');
