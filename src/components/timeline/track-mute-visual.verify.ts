import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const timeline = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
const lane = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

assert.match(timeline, /muted=\{config\.muted \?\? false\}/);
assert.match(lane, /muted:\s*boolean/);
assert.match(lane, /muted\s*&&\s*\(it\.kind === 'audio' \|\| it\.kind === 'video'\)/);
assert.match(lane, /is-audio-muted/);
assert.match(lane, /cc-clip-muted-indicator[\s\S]*?volumeOff/);
assert.match(css, /\.cc-timeline-clip\.is-audio-muted::after/);
assert.match(css, /\.cc-clip-muted-indicator/);

console.log('track-mute-visual.verify: muted audio-bearing clips are visibly distinct');
