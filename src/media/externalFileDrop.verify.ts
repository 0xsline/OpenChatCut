import assert from 'node:assert/strict';
import { classifyExternalFile, parseDroppedCaptions } from './externalFileDrop';

assert.deepEqual(classifyExternalFile({ name: '旅行.mp4', type: 'video/mp4' }), {
  type: 'media', mediaKind: 'video',
});
assert.deepEqual(classifyExternalFile({ name: '旁白.mp3', type: 'audio/mpeg' }), {
  type: 'media', mediaKind: 'audio',
});
assert.deepEqual(classifyExternalFile({ name: '字幕.srt', type: '' }), {
  type: 'caption', format: 'srt',
});
assert.deepEqual(
  parseDroppedCaptions(
    '字幕.srt',
    '1\n00:00:01,000 --> 00:00:02,500\n第一句\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句',
    10000,
  ),
  [
    { text: '第一句', start: 10000, end: 11500 },
    { text: '第二句', start: 12000, end: 13000 },
  ],
);
assert.deepEqual(
  parseDroppedCaptions('文案.txt', '第一行\n\n第二行', 4000),
  [
    { text: '第一行', start: 4000, end: 7000 },
    { text: '第二行', start: 7000, end: 10000 },
  ],
);

console.log('externalFileDrop.verify: Finder media and caption classification OK');
