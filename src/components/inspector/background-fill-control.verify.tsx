import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { BackgroundFillControlView } from './BackgroundFillControl';
import { resolveBackgroundFillToggle } from './backgroundFillControlState';

const markup = renderToStaticMarkup(
  <BackgroundFillControlView
    enabled
    preset="strong"
    translate={(key) => key}
    onChange={() => undefined}
    onApplyToAll={() => undefined}
  />,
);

assert.match(markup, /aria-label="背景填充效果"/);
assert.equal((markup.match(/role="radio"/g) ?? []).length, 4, 'four blur presets stay visible');
assert.match(markup, /aria-checked="true"[^>]*class="selected"/);
assert.match(markup, />全部应用<\/button>/);
assert.match(markup, /用片段副本填满画布空白/);

const disabled = renderToStaticMarkup(
  <BackgroundFillControlView enabled={false} preset="medium" translate={(key) => key}
    onChange={() => undefined} />,
);
assert.doesNotMatch(disabled, /aria-label="背景填充效果"/, 'disabled fills keep the effect picker collapsed');

for (const enabled of [false, true]) {
  const mixed = renderToStaticMarkup(
    <BackgroundFillControlView enabled={enabled} mixed preset="maximum" presetMixed
      translate={(key) => key} onChange={() => undefined} onApplyToAll={() => undefined} />,
  );
  assert.match(mixed, /class="cc-bg-fill-apply" disabled=""/,
    'mixed presets cannot be silently applied from the primary item');
  assert.doesNotMatch(mixed, /aria-checked="true"/,
    'mixed presets do not present the primary item as the shared selection');
}

assert.deepEqual(resolveBackgroundFillToggle(true, false, 'maximum', true), { enabled: true },
  'mixed presets enable all without copying a disabled primary item preset');
assert.deepEqual(resolveBackgroundFillToggle(true, true, 'soft', true), { enabled: true },
  'mixed presets enable all without copying an enabled primary item preset');
assert.deepEqual(resolveBackgroundFillToggle(true, false, 'strong', false),
  { enabled: true, preset: 'strong' }, 'a shared preset is retained while enabling mixed states');
assert.deepEqual(resolveBackgroundFillToggle(false, false, 'medium', false), { enabled: false },
  'a settled enabled selection can still be disabled');

console.log('background-fill-control.verify: toggle, four presets, selection, and apply-all controls ok');
