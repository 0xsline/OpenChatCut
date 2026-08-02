import assert from 'node:assert/strict';
import { resolveRenderTimeout } from './render-timeout.mjs';

assert.equal(resolveRenderTimeout(undefined), 120_000, 'export initialization should allow slow local font and media setup');
assert.equal(resolveRenderTimeout('90000'), 90_000, 'operators may lower the timeout explicitly');
assert.equal(resolveRenderTimeout('9999999'), 600_000, 'the override must remain bounded');
assert.equal(resolveRenderTimeout('not-a-number'), 120_000, 'invalid overrides must use the safe default');

console.log('render-timeout.verify: export initialization timeout is bounded and configurable');
