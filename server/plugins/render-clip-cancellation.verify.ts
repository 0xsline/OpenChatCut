import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plugin = readFileSync(new URL('./export.ts', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../remotion/render.mjs', import.meta.url), 'utf8');

assert.match(
  plugin,
  /server\.middlewares\.use\('\/render-clip'[\s\S]*?new AbortController\(\)[\s\S]*?req\.once\('aborted'[\s\S]*?signal: controller\.signal/,
  'aborting an MG export request must stop the server-side clip render',
);
assert.match(
  renderer,
  /export async function renderClip\(\{[\s\S]*?signal[\s\S]*?cancelSignal/,
  'the clip renderer must bridge AbortSignal to Remotion cancellation',
);
assert.match(
  plugin,
  /catch \(err\) \{\s*if \(controller\.signal\.aborted\) return;/,
  'an expected client disconnect must not be logged or answered as a server failure',
);

console.log('render-clip-cancellation.verify: aborted MG requests stop local rendering');
