import assert from 'node:assert/strict';
import { parseSrt } from './srt';

const cues = parseSrt('1\n00:00:01,250 --> 00:00:03,500\nHello <i>world</i>.\n\n2\n00:00:04.000 --> 00:00:05.250\nSecond cue');
assert.deepEqual(cues, [
  { text: 'Hello world.', start: 1250, end: 3500 },
  { text: 'Second cue', start: 4000, end: 5250 },
]);
assert.throws(() => parseSrt('not an srt file'), /No valid SRT cues found/);
console.log('srt.verify: ok');
