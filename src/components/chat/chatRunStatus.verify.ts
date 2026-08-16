import assert from 'node:assert/strict';
import { elapsedRunSeconds } from './ChatRunStatus.ts';

assert.equal(elapsedRunSeconds(10_000, 13_400), 3.4);
assert.equal(elapsedRunSeconds(13_400, 10_000), 0);

console.log('chat run elapsed timer checks passed');
