import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const laneSource = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

assert.match(
  laneSource,
  /<span className="cc-clip-duration" data-cc-live-duration=\{dur\}>\{fmt\(dur, state\.fps\)\}<\/span>/,
  'each timeline clip should display its current retained duration',
);
assert.match(
  cssSource,
  /\.cc-clip-duration\s*\{[^}]*position:\s*absolute;[^}]*top:\s*3px;[^}]*left:\s*50%;/s,
  'clip duration should stay centered at the top of its own clip',
);
assert.match(
  cssSource,
  /\.cc-clip-duration\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/s,
  'live duration digits should not shift while trimming',
);

console.log('timeline-clip-duration.verify: each clip owns a live duration label');
