// A packaged install that lost bundled files must say so. Before this, boot()
// rejected on the first missing asset and main.ts exited with no window and no
// dialog, which is the whole of issue #140: "双击没有反应".
// npx tsx desktop/runtime-preflight.verify.ts
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  describeMissingRuntimeAssets,
  missingRuntimeAssets,
  packagedRuntimeAssetChecks,
  runtimeAssetFailure,
} from './runtime-preflight.ts';

const resourcesPath = join('C:', 'Program Files', 'OpenChatCut', 'resources');
const ffmpegPath = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

const windows = packagedRuntimeAssetChecks({ resourcesPath, platform: 'win32', ffmpegPath });
const mac = packagedRuntimeAssetChecks({ resourcesPath, platform: 'darwin', ffmpegPath });

assert.deepEqual(
  windows.map((check) => check.path),
  [
    join(resourcesPath, 'dist', 'index.html'),
    join(resourcesPath, 'remotion-bundle', 'index.html'),
    join(resourcesPath, 'chrome-headless-shell'),
    ffmpegPath,
  ],
  'the checked paths are the ones boot() reads before any window exists',
);
assert.equal(
  mac.some((check) => check.path === ffmpegPath),
  false,
  'only Windows mirrors the static ffmpeg at first launch, so only there is it startup-critical',
);
assert.deepEqual(
  windows.filter((check) => !check.required).map((check) => check.path),
  [join(resourcesPath, 'chrome-headless-shell')],
  'a missing render browser degrades exports; it does not block the editor',
);

// A complete install launches: nothing is reported and nothing blocks.
assert.deepEqual(missingRuntimeAssets(windows, () => true), []);
assert.equal(runtimeAssetFailure(missingRuntimeAssets(windows, () => true)), null);

// Only the optional asset is gone: still launch.
const withoutBrowser = missingRuntimeAssets(windows, (path) => !path.endsWith('chrome-headless-shell'));
assert.equal(withoutBrowser.length, 1);
assert.equal(runtimeAssetFailure(withoutBrowser), null, 'an optional asset never blocks the launch');
assert.match(
  describeMissingRuntimeAssets(withoutBrowser),
  /可选 \/ optional/,
  'the report marks which entries are optional',
);

// The reported scenario: quarantined ffmpeg plus a truncated extraction.
const broken = missingRuntimeAssets(windows, (path) => path.endsWith('chrome-headless-shell'));
const failure = runtimeAssetFailure(broken);
assert.ok(failure, 'a missing required asset blocks the launch with a message');
assert.match(failure, /missing 3 bundled file\(s\)/);
for (const path of [join(resourcesPath, 'dist', 'index.html'), join(resourcesPath, 'remotion-bundle', 'index.html'), ffmpegPath]) {
  assert.ok(failure.includes(path), `the failure names ${path} so the user can report or restore it`);
}
assert.match(failure, /杀毒软件/, 'the message names the usual cause in Chinese');
assert.match(failure, /antivirus/, 'and in English');
assert.match(failure, /Reinstall OpenChatCut/, 'and tells the user what to do');

console.log('runtime-preflight.verify: a packaged install that lost bundled files names them instead of exiting silently');
