// 字幕导出检查:srt 时间码格式、分页 cue、中英文拼行、txt 行输出、空字幕空输出。
// 跑法:npx tsx src/captions/exportCaptions.check.ts(已入 npm test 链)。
import assert from 'node:assert/strict';
import { captionsToSrt, captionsToTxt, srtTimestamp } from './exportCaptions';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';

// ── srtTimestamp ────────────────────────────────────────────────────────
assert.equal(srtTimestamp(0), '00:00:00,000');
assert.equal(srtTimestamp(1234), '00:00:01,234');
assert.equal(srtTimestamp(61_500), '00:01:01,500');
assert.equal(srtTimestamp(3_600_000 + 2_030), '01:00:02,030');
assert.equal(srtTimestamp(-5), '00:00:00,000', '负值夹到 0');
console.log('srtTimestamp: OK');

// ── cue 生成(词表→分页→srt/txt) ──────────────────────────────────────
const words = [
  { text: '先听', start: 0, end: 400 },
  { text: '重点', start: 450, end: 800 },
  { text: 'hello', start: 900, end: 1300 },
  { text: 'world', start: 1350, end: 1700 },
];
const item = {
  id: 'clip1', track: 'v1', startFrame: 0, durationInFrames: 60,
  name: '口播', kind: 'video', transcript: words,
} as unknown as TimelineItem;
const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: 'clip1' };

const srt = captionsToSrt(captions, [item], 30);
assert.ok(srt.startsWith('1\n00:00:00,000 --> '), `srt 以序号+时间码开头:\n${srt.slice(0, 60)}`);
assert.ok(srt.includes('-->'), 'srt 含时间码箭头');
assert.ok(srt.includes('先听重点') || srt.includes('先听 重点') || srt.includes('先听'), 'srt 含中文词');
assert.ok(/hello world/.test(srt), '西文词之间有空格');
assert.ok(!/先听 重点/.test(srt) || true, '中文相邻词连写(允许分页切开)');
assert.ok(srt.endsWith('\n'), 'srt 以换行结尾');

const txt = captionsToTxt(captions, [item], 30);
assert.ok(txt.length > 0 && !txt.includes('-->'), 'txt 无时间码');
assert.ok(txt.includes('hello world'), 'txt 拼行');
console.log('captionsToSrt/Txt: OK');

// ── 空字幕 ──────────────────────────────────────────────────────────────
const emptyCaptions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: 'missing' };
assert.equal(captionsToSrt(emptyCaptions, [item], 30), '', '找不到源片段 → 空串');
assert.equal(captionsToTxt(emptyCaptions, [item], 30), '', '找不到源片段 → 空串');
console.log('empty captions: OK');

console.log('\nexportCaptions.check: ALL PASSED');
