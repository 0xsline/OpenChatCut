import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./usePlayheadPaint.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /raf\s*=\s*requestAnimationFrame\(tick\)/,
  'paused timelines must not poll Player identity every animation frame',
);
assert.match(
  source,
  /setInterval\(tick,\s*100\)/,
  'the low-frequency watchdog must still discover a remounted Player promptly',
);

console.log('playhead-watchdog.verify: paused Player identity checks are low frequency');
