import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const moduleUrl = new URL('./single-instance.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop single-instance focus behavior must be testable');

if (existsSync(moduleUrl)) {
  const { focusExistingWindow } = await import(moduleUrl.href);
  const calls: string[] = [];
  focusExistingWindow({
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
  });
  assert.deepEqual(calls, ['restore', 'focus'], 'a minimized primary window restores before focus');

  calls.length = 0;
  focusExistingWindow({
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    focus: () => calls.push('focus'),
  });
  assert.deepEqual(calls, ['focus'], 'a visible primary window only receives focus');
}

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
assert.match(mainSource, /requestSingleInstanceLock\(\)/, 'desktop must request a single-instance lock');
assert.match(mainSource, /second-instance/, 'a second launch must focus the existing window');

console.log('desktop single-instance verification passed');
