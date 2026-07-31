// Runnable check: `npx tsx src/persist/uploadRefs.verify.ts`.
// Asset reference inventory is the basis for deleting files. Missing one means deleting assets that the user is still using. Here are two things to verify:
// ① denoisedSrc (the product of isolate_voice, directly linked to the path without creating the asset) must be counted as a reference;
// ② When the project document cannot be read, it degenerates into scanning the original bytes instead of treating it as a "zero reference".
import assert from 'node:assert/strict';
import { collectUploadSrcs, rawUploadSrcs } from './projectTransfer';
import type { ProjectDoc } from '../editor/types';

const docOf = (items: unknown[], assets: unknown[] = []): ProjectDoc => ({
  version: 3, assets, mediaFolders: [], activeTimelineId: 'tl1',
  timelines: [{
    id: 'tl1', name: 'main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { A1: { kind: 'audio' } }, trackOrder: ['A1'], items,
  }],
} as unknown as ProjectDoc);

// ── denoisedSrc must be counted as a reference ──
{
  const doc = docOf(
    [{ id: 'a', track: 'A1', startFrame: 0, durationInFrames: 30, kind: 'audio', name: 'a', src: '/media/uploads/raw.wav', denoisedSrc: '/media/uploads/clean.wav' }],
    [{ id: 'as1', name: 'raw', kind: 'audio', src: '/media/uploads/raw.wav', durationInFrames: 30 }],
  );
  const refs = collectUploadSrcs(doc);
  assert.ok(refs.includes('/media/uploads/raw.wav'), '源素材');
  assert.ok(
    refs.includes('/media/uploads/clean.wav'),
    'isolate_voice 的产物只以 denoisedSrc 存在,漏掉它清理就会删掉正在播放的音轨',
  );
  assert.equal(new Set(refs).size, refs.length, '不重复');
}

// ── Original bytes that cannot be read: still need to fish out the reference ──
{
  // The version is newer than the local machine → migrateProjectDoc returns null, but the project is not broken at all
  const future = {
    version: 999, assets: [{ src: '/media/uploads/a.mp4' }], mediaFolders: [],
    activeTimelineId: 'tl1',
    timelines: [{ id: 'tl1', items: [{ src: '/media/uploads/b.wav', denoisedSrc: '/media/uploads/c.wav' }] }],
  };
  const refs = rawUploadSrcs(future).sort();
  assert.deepEqual(refs, ['/media/uploads/a.mp4', '/media/uploads/b.wav', '/media/uploads/c.wav']);
}

// ── Boundaries: null value, illegal name, query string, repetition ──
{
  assert.deepEqual(rawUploadSrcs(null), []);
  assert.deepEqual(rawUploadSrcs(undefined), []);
  assert.deepEqual(rawUploadSrcs({}), []);
  assert.deepEqual(rawUploadSrcs('/media/uploads/x.mp4"'), ['/media/uploads/x.mp4'], '直接给字符串也能扫');
  assert.deepEqual(
    rawUploadSrcs({ a: '/media/uploads/dup.mp4', b: '/media/uploads/dup.mp4' }),
    ['/media/uploads/dup.mp4'],
    '同一个文件只算一次',
  );
  assert.deepEqual(
    rawUploadSrcs({ a: '/media/uploads/.hidden', b: '/media/uploads/ok.mp4' }),
    ['/media/uploads/ok.mp4'],
    '点开头的名字不合法,不当引用',
  );
  assert.deepEqual(
    rawUploadSrcs({ a: '/media/uploads/f.mp4?v=2' }),
    ['/media/uploads/f.mp4'],
    '查询串不进文件名',
  );
  // Circular reference: If it cannot be scanned, it will return empty, and the caller will handle it as unknown (instead of throwing an exception and causing the entire cleanup to hang up)
  const cyclic: Record<string, unknown> = { src: '/media/uploads/z.mp4' };
  cyclic.self = cyclic;
  assert.deepEqual(rawUploadSrcs(cyclic), []);
}

// ── It is better to keep more than delete by mistake: the original scan is a superset of collectUploadSrcs ──
{
  const doc = docOf(
    [{ id: 'a', track: 'A1', startFrame: 0, durationInFrames: 30, kind: 'audio', name: 'a', src: '/media/uploads/raw.wav', denoisedSrc: '/media/uploads/clean.wav' }],
    [{ id: 'as1', name: 'raw', kind: 'audio', src: '/media/uploads/raw.wav', durationInFrames: 30 }],
  );
  const raw = new Set(rawUploadSrcs(doc));
  for (const src of collectUploadSrcs(doc)) {
    assert.ok(raw.has(src), `原始扫描漏了 ${src},退化路径就会比正常路径更危险`);
  }
}

console.log('uploadRefs.verify: ok (denoisedSrc 计入/读不出时扫原始字节/边界/超集关系)');
