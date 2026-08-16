import assert from 'node:assert/strict';
import { buildActions, saveScreenshot, wrapExecJs } from './firecrawl';
import { resolveE2bFileBytes } from './e2b';

// ── wrapExecJs ─────────────────────────────────────────────────────────────
// Top-level `return` (the model's natural style) must be wrapped in an IIFE so
// Firecrawl's executor does not reject it with "Illegal return statement".
assert.equal(
  wrapExecJs('return document.querySelector("audio").src'),
  '(() => {\nreturn document.querySelector("audio").src\n})()',
  'single-line top-level return is wrapped in an IIFE',
);
assert.equal(
  wrapExecJs('  return a + b'),
  '(() => {\n  return a + b\n})()',
  'leading whitespace before return is still detected',
);
assert.equal(
  wrapExecJs('const x = 1;\nreturn x'),
  '(() => {\nconst x = 1;\nreturn x\n})()',
  'multi-line script with later return is wrapped',
);
assert.equal(
  wrapExecJs('document.querySelector("a").href'),
  'document.querySelector("a").href',
  'bare expression passes through untouched',
);
assert.equal(
  wrapExecJs('const el = document.querySelector("a");\nif (el) { el.click(); }'),
  'const el = document.querySelector("a");\nif (el) { el.click(); }',
  'multi-line script without top-level return passes through',
);
assert.equal(
  wrapExecJs('(() => { return 42 })()'),
  '(() => { return 42 })()',
  'already-IIFE script passes through',
);

// ── buildActions ───────────────────────────────────────────────────────────
assert.equal(buildActions(undefined, undefined), undefined, 'no actions and no execJs → undefined');

const wrapped = buildActions(
  [{ type: 'executeJavascript', script: 'return location.href' }],
  undefined,
) as Array<{ type: string; script: string }>;
assert.equal(wrapped.length, 1, 'single action kept');
assert.equal(wrapped[0]?.type, 'executeJavascript');
assert.equal(
  wrapped[0]?.script,
  '(() => {\nreturn location.href\n})()',
  'executeJavascript action script is wrapped',
);

const mixed = buildActions(
  [{ type: 'wait', milliseconds: 500 }, { type: 'executeJavascript', script: 'document.title' }],
  'return window.scrollY',
) as Array<{ type: string; script?: string; milliseconds?: number }>;
assert.equal(mixed.length, 3, 'wait + executeJavascript + execJs all kept');
assert.deepEqual(mixed[0], { type: 'wait', milliseconds: 500 }, 'non-JS action untouched');
assert.equal(mixed[1]?.script, 'document.title', 'expression action script untouched');
assert.equal(
  mixed[2]?.script,
  '(() => {\nreturn window.scrollY\n})()',
  'execJs top-level return is wrapped',
);

// Cap at 10 actions (existing behavior preserved).
const many = buildActions(
  Array.from({ length: 15 }, (_, i) => ({ type: 'wait', milliseconds: i })),
  undefined,
) as unknown[];
assert.equal(many.length, 10, 'actions capped at 10');

await assert.rejects(
  resolveE2bFileBytes({ path: '/tmp/private', url: 'http://127.0.0.1/private' }),
  /non-public address/,
  'E2B URL imports reject private network targets',
);
assert.equal(await saveScreenshot('http://127.0.0.1/private.png'), null,
  'Firecrawl screenshot downloads reject private network targets');

console.log('firecrawl.verify: wrapExecJs + buildActions passed');
