// 工程导出/导入纯逻辑检查:src 收集、信封边界校验(不可信文件)。
// 跑法:npx tsx src/persist/projectTransfer.check.ts(已入 npm test 链)。
import assert from 'node:assert/strict';
import { collectUploadSrcs, parseProjectEnvelope, PROJECT_EXPORT_FORMAT } from './projectTransfer';

const doc = {
  version: 2,
  assets: [
    { id: 'a1', name: 'v.mp4', kind: 'video', src: '/media/uploads/v.mp4', durationInFrames: 60 },
    { id: 'a2', name: 'pic.png', kind: 'image', src: '/media/uploads/pic.png', durationInFrames: 90 },
    { id: 'a3', name: 'ext', kind: 'image', src: 'https://cdn.example.com/x.png', durationInFrames: 90 },
  ],
  timelines: [{
    id: 'tl_1', name: '序列 1', fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [
      { id: 'i1', kind: 'video', track: 'v1', startFrame: 0, durationInFrames: 60, src: '/media/uploads/v.mp4' },
      { id: 'i2', kind: 'audio', track: 'a1', startFrame: 0, durationInFrames: 60, src: '/media/uploads/bgm.mp3' },
      { id: 'i3', kind: 'text', track: 'v2', startFrame: 0, durationInFrames: 30 },
    ],
  }],
  activeTimelineId: 'tl_1',
};

// ── collectUploadSrcs ───────────────────────────────────────────────────
{
  const srcs = collectUploadSrcs(doc as never);
  assert.deepEqual(srcs, ['/media/uploads/v.mp4', '/media/uploads/pic.png', '/media/uploads/bgm.mp3'],
    '素材池+时间线合集,去重保序,外链不收');
  console.log('collectUploadSrcs: OK');
}

// ── parseProjectEnvelope ────────────────────────────────────────────────
{
  const good = {
    format: PROJECT_EXPORT_FORMAT, name: ' 迁移工程 ', exportedAt: '2026-07-18T00:00:00Z', doc,
    chat: { messages: [], llm: [] },
    creativeMode: 'long-video-to-shorts',
    media: [
      { src: '/media/uploads/v.mp4', name: 'v.mp4', mime: 'video/mp4', bytes: 10, dataBase64: 'AAAA' },
      { src: '/media/uploads/../etc', name: 'x', mime: 'x', bytes: 1, dataBase64: 'AA' },      // 穿越 → 丢
      { src: '/media/uploads/ok.png', name: 'a/b.png', mime: 'x', bytes: 1, dataBase64: 'AA' }, // name 带路径 → 丢
      { src: '/media/uploads/big.mov', name: 'big.mov', mime: 'x', bytes: 1e12, dataBase64: 'AA' }, // 超上限 → 丢
      { src: '/media/uploads/nob64.png', name: 'n.png', mime: 'x', bytes: 5, dataBase64: '' },  // 空数据 → 丢
    ],
  };
  const parsed = parseProjectEnvelope(JSON.stringify(good));
  assert.ok('envelope' in parsed, `应通过:${'error' in parsed ? parsed.error : ''}`);
  if ('envelope' in parsed) {
    assert.equal(parsed.envelope.name, '迁移工程', '名字 trim');
    assert.equal(parsed.envelope.media.length, 1, '不安全/超限条目全被滤掉');
    assert.equal(parsed.envelope.media[0].src, '/media/uploads/v.mp4');
    assert.ok(parsed.envelope.chat, 'chat 形状对就保留');
    assert.equal(parsed.envelope.creativeMode, 'long-video-to-shorts');
    assert.equal(parsed.envelope.doc.timelines.length, 1, 'doc 走 migrateProjectDoc 存活');
  }

  assert.deepEqual(parseProjectEnvelope('not json'), { error: '不是合法的 JSON 文件' });
  const wrongFormat = parseProjectEnvelope(JSON.stringify({ ...good, format: 'foreign-project@1' }));
  assert.ok('error' in wrongFormat, '插件包格式拒收');
  const badDoc = parseProjectEnvelope(JSON.stringify({ ...good, doc: { timelines: [] } }));
  assert.ok('error' in badDoc, '空时间线 doc 拒收');
  const badChat = parseProjectEnvelope(JSON.stringify({ ...good, chat: { messages: 'x' } }));
  assert.ok('envelope' in badChat && !(badChat as { envelope: { chat?: unknown } }).envelope.chat, '坏 chat 丢弃不致命');
  console.log('parseProjectEnvelope: OK');
}

console.log('\nprojectTransfer.check: ALL PASSED');
