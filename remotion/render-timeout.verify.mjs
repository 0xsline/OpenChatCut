// The per-frame budget bounds ONE frame's async work, not the export. It is
// there to catch a hung frame — a delayRender() that will never clear — and to
// trigger Remotion's one-shot frame retry, not to police slow-but-progressing
// sources. So the default is generous and the override stays bounded.
// node remotion/render-timeout.verify.mjs
import assert from 'node:assert/strict';
import { DEFAULT_RENDER_TIMEOUT_MS, resolveRenderTimeout } from './render-timeout.mjs';

assert.equal(DEFAULT_RENDER_TIMEOUT_MS, 600_000,
  'ten minutes: a frame with no data by then is hung, not slow');
assert.equal(resolveRenderTimeout(undefined), DEFAULT_RENDER_TIMEOUT_MS,
  'no override resolves to the shared default');

assert.equal(resolveRenderTimeout('90000'), 90_000, 'operators may lower the timeout explicitly');
assert.equal(resolveRenderTimeout('1200000'), 1_200_000,
  'and may raise it above the default — the default must not be the ceiling');
assert.equal(resolveRenderTimeout('99999999'), 3_600_000, 'the override must remain bounded');
assert.equal(resolveRenderTimeout('1'), 30_000, 'a too-small override is clamped, not honoured');
assert.equal(resolveRenderTimeout('not-a-number'), DEFAULT_RENDER_TIMEOUT_MS,
  'invalid overrides must use the safe default');
assert.equal(resolveRenderTimeout('0'), DEFAULT_RENDER_TIMEOUT_MS,
  'zero is not a way to disable the hang guard');

console.log('render-timeout.verify: the per-frame hang guard is bounded and configurable');
