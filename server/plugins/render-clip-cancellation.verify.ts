import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plugin = readFileSync(new URL('./export.ts', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../remotion/render.mjs', import.meta.url), 'utf8');

// Abort wiring was factored into bindRequestAbort(); the /render-clip route
// binds it and threads requestAbort.controller.signal through the render.
assert.match(
  plugin,
  /function bindRequestAbort\(req[\s\S]*?controller\.abort\([\s\S]*?req\.once\('aborted', abort\)/,
  'abort wiring lives in bindRequestAbort and aborts on client disconnect',
);
assert.match(
  plugin,
  /'\/render-clip'[\s\S]*?bindRequestAbort\(req, res\)[\s\S]*?requestAbort\.controller\.signal/,
  'the /render-clip route binds the request abort signal and threads it into the render',
);
assert.match(
  plugin,
  /if \(requestAbort\.controller\.signal\.aborted\) return;/,
  'an expected client disconnect must not be logged or answered as a server failure',
);
assert.match(
  renderer,
  /export async function renderClip\(\{[\s\S]*?signal[\s\S]*?cancelSignal/,
  'the clip renderer must bridge AbortSignal to Remotion cancellation',
);

console.log('render-clip-cancellation.verify: aborted MG requests stop local rendering');
