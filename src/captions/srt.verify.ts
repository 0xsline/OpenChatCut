import assert from 'node:assert/strict';
import { parseSrt } from './srt';

const cues = parseSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500 position:50%\r\nHello <i>world</i> &amp; all.\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.250\r\nSecond\r\nline');
assert.deepEqual(cues, [
  { text: 'Hello world & all.', start: 1250, end: 3500 },
  { text: 'Second line', start: 4000, end: 5250 },
]);

assert.deepEqual(parseSrt([
  '2',
  '00:00:05,000 --> 00:00:06,000',
  'later',
  '',
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'earlier &#x26; safe',
].join('\n')).map((cue) => cue.text), ['earlier & safe', 'later']);

assert.throws(
  () => parseSrt('1\n00:00:60,000 --> 00:00:61,000\ninvalid time'),
  /没有有效字幕/,
);
assert.throws(
  () => parseSrt('1\n00:00:03,000 --> 00:00:02,000\nbackwards'),
  /没有有效字幕/,
);
assert.throws(() => parseSrt('not an srt file'), /没有有效字幕/);

console.log('srt.verify: ok');
