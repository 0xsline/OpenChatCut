import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_MIN_SCALE,
  resolveDesktopWindowScale,
  resolveInitialDesktopWindowBounds,
} from './window-scale.ts';

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

assert.match(mainSource, /\bscreen\b/, 'desktop startup must read the available display work area');
assert.match(
  mainSource,
  /resolveInitialDesktopWindowBounds\(screen\.getPrimaryDisplay\(\)\.workArea\)/,
  'desktop startup must derive its initial bounds from the primary display work area',
);
assert.match(
  mainSource,
  /installResponsiveWindowScale\(win\)/,
  'desktop startup must keep renderer scaling synchronized with native window resizing',
);

assert.equal(DESKTOP_MIN_SCALE, 2 / 3, 'desktop controls stop shrinking at two-thirds scale');

assert.deepEqual(
  resolveInitialDesktopWindowBounds({ x: 0, y: 25, width: 1920, height: 1055 }),
  { x: 288, y: 105, width: 1344, height: 896 },
  'startup uses 70% width, a 3:2 shape, and the display work-area origin',
);

assert.deepEqual(
  resolveInitialDesktopWindowBounds({ x: 1920, y: 0, width: 2560, height: 1440 }),
  { x: 2304, y: 123, width: 1792, height: 1195 },
  'startup centers correctly on a display with a non-zero origin',
);

assert.deepEqual(
  resolveInitialDesktopWindowBounds({ x: 0, y: 0, width: 3440, height: 1440 }),
  { x: 748, y: 72, width: 1944, height: 1296 },
  'ultrawide displays cap startup height at 90% while preserving the 3:2 shape',
);

const baseline = resolveDesktopWindowScale({
  baselineContentWidth: 1600,
  baselineContentHeight: 920,
  contentWidth: 1600,
  contentHeight: 920,
  frameWidth: 0,
  frameHeight: 30,
});
assert.equal(baseline.zoomFactor, 1, 'the authored desktop size renders at 100%');
assert.deepEqual(
  baseline.minimumWindowSize,
  { width: 1067, height: 839 },
  'minimum window preserves two-thirds scale and a full 30%-wide 9:16 preview',
);

const liveScreenBaseline = resolveDesktopWindowScale({
  baselineContentWidth: 1210,
  baselineContentHeight: 676,
  contentWidth: 1210,
  contentHeight: 676,
  frameWidth: 0,
  frameHeight: 28,
});
assert.deepEqual(
  liveScreenBaseline.minimumWindowSize,
  { width: 807, height: 698 },
  'portrait-preview minimum remains below the 1210x704 startup window',
);

assert.equal(
  resolveDesktopWindowScale({
    baselineContentWidth: 1600,
    baselineContentHeight: 920,
    contentWidth: 1280,
    contentHeight: 920,
  }).zoomFactor,
  0.8,
  'narrowing the window scales the whole renderer proportionally',
);

assert.equal(
  resolveDesktopWindowScale({
    baselineContentWidth: 1600,
    baselineContentHeight: 920,
    contentWidth: 1400,
    contentHeight: 736,
  }).zoomFactor,
  0.8,
  'height reduction follows the same proportional fit rule',
);

assert.equal(
  resolveDesktopWindowScale({
    baselineContentWidth: 1600,
    baselineContentHeight: 920,
    contentWidth: 800,
    contentHeight: 460,
  }).zoomFactor,
  2 / 3,
  'renderer scaling is clamped before controls become too small',
);

assert.equal(
  resolveDesktopWindowScale({
    baselineContentWidth: 1600,
    baselineContentHeight: 920,
    contentWidth: 2400,
    contentHeight: 1200,
  }).zoomFactor,
  1,
  'enlarging the window adds workspace instead of magnifying controls',
);

console.log('window-scale.verify: responsive desktop bounds and renderer scaling passed');

// ── User UI scale (issue #85): composes over shrink-to-fit, clamped ──
{
  const { resolveDesktopWindowScale, parseUserUiScale, DESKTOP_UI_SCALE_MIN, DESKTOP_UI_SCALE_MAX } = await import('./window-scale');
  const base = { baselineContentWidth: 1440, baselineContentHeight: 900, contentWidth: 1440, contentHeight: 900 };
  assert.equal(resolveDesktopWindowScale(base).zoomFactor, 1, 'default user scale keeps 100%');
  assert.equal(resolveDesktopWindowScale({ ...base, userScale: 1.5 }).zoomFactor, 1.5, '150% grows the UI');
  assert.equal(resolveDesktopWindowScale({ ...base, userScale: 0.8 }).zoomFactor, 0.8, '80% shrinks the UI');
  // fitted 0.5 is below the 2/3 floor, so it clamps first: 1.25 × 2/3.
  assert.equal(
    resolveDesktopWindowScale({ ...base, contentWidth: 720, contentHeight: 900, userScale: 1.25 }).zoomFactor,
    0.833,
    'user scale composes with the clamped shrink-to-fit (1.25 × 2/3)',
  );
  // fitted 0.75 is above the floor: 0.8 × 0.75 = 0.6.
  assert.equal(
    resolveDesktopWindowScale({ ...base, contentWidth: 1080, contentHeight: 900, userScale: 0.8 }).zoomFactor,
    0.6,
    'user scale composes with an unclamped fitted ratio (0.8 × 0.75)',
  );
  assert.equal(
    resolveDesktopWindowScale({ ...base, contentWidth: 480, contentHeight: 300, userScale: 1 }).zoomFactor,
    2 / 3,
    'the fitted floor still applies with default user scale',
  );
  assert.equal(parseUserUiScale('1.25'), 1.25, 'parses a saved scale');
  assert.equal(parseUserUiScale(undefined), 1, 'missing value falls back to 1');
  assert.equal(parseUserUiScale('garbage'), 1, 'garbage falls back to 1');
  assert.equal(parseUserUiScale('3'), DESKTOP_UI_SCALE_MAX, 'upper clamp');
  assert.equal(parseUserUiScale('0.2'), DESKTOP_UI_SCALE_MIN, 'lower clamp');
}
