import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const moduleUrl = new URL('./window-frame.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop window frame policy must be independently testable');

if (existsSync(moduleUrl)) {
  const { applyDesktopWindowFrame, desktopWindowFrameOptions } = await import(moduleUrl.href);
  assert.deepEqual(
    desktopWindowFrameOptions('darwin'),
    { titleBarStyle: 'hiddenInset' },
    'macOS reserves an inset titlebar region for renderer controls',
  );
  assert.deepEqual(desktopWindowFrameOptions('win32'), {}, 'Windows keeps its native frame');
  assert.deepEqual(desktopWindowFrameOptions('linux'), {}, 'Linux keeps its native frame');

  const visibilityCalls: boolean[] = [];
  applyDesktopWindowFrame({
    setWindowButtonVisibility: (visible: boolean) => visibilityCalls.push(visible),
  }, 'darwin');
  assert.deepEqual(visibilityCalls, [false], 'macOS native traffic lights are hidden when renderer controls exist');

  applyDesktopWindowFrame({
    setWindowButtonVisibility: (visible: boolean) => visibilityCalls.push(visible),
  }, 'win32');
  assert.deepEqual(visibilityCalls, [false], 'non-macOS platforms do not call macOS window APIs');
}

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
assert.match(mainSource, /openchatcut:window-action/, 'main process must register window actions');

console.log('desktop window-frame verification passed');
