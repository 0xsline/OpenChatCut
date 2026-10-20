import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compositorPackageName, ensureRemotionBinaries } from './remotion-binaries.ts';

assert.equal(compositorPackageName('darwin', 'arm64'), '@remotion/compositor-darwin-arm64');
assert.equal(compositorPackageName('darwin', 'x64'), '@remotion/compositor-darwin-x64');
assert.equal(compositorPackageName('win32', 'x64'), '@remotion/compositor-win32-x64-msvc');
assert.equal(compositorPackageName('linux', 'x64'), '@remotion/compositor-linux-x64-gnu');
assert.equal(compositorPackageName('linux', 'arm64'), '@remotion/compositor-linux-arm64-gnu');

const root = await mkdtemp(join(tmpdir(), 'openchatcut-remotion-binaries-'));
try {
  // Windows: the stock mirror keeps the compositor's own ffmpeg, which has the libfdk_aac
  // that Remotion's AAC encode needs; only the hardware mirror carries the static build.
  // Rendering everything from a swapped mirror failed every software export (issue #223).
  const compositor = join(root, 'compositor');
  const userData = join(root, 'user-data');
  const richFfmpeg = join(root, 'rich-ffmpeg.exe');
  await mkdir(compositor, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(compositor, 'remotion.exe'), 'compositor');
  await writeFile(join(compositor, 'ffmpeg.exe'), 'limited');
  await writeFile(join(compositor, 'ffprobe.exe'), 'probe');
  await writeFile(join(compositor, 'avcodec.dll'), 'dll');
  await writeFile(richFfmpeg, 'nvenc-qsv-amf');

  // An install from before the split left a swapped mirror under the stock name.
  const legacy = join(userData, 'remotion-binaries-0.2.7');
  await mkdir(legacy, { recursive: true });
  for (const name of ['remotion.exe', 'ffprobe.exe']) await writeFile(join(legacy, name), 'old');
  await writeFile(join(legacy, 'ffmpeg.exe'), 'nvenc-qsv-amf');
  await writeFile(join(legacy, '.openchatcut-ready'), 'ok');

  const windows = { userDataPath: userData, version: '0.2.7', platform: 'win32' as const, compositorDirectory: compositor, ffmpegPath: richFfmpeg };
  const binaries = await ensureRemotionBinaries(windows);
  assert.equal(binaries.stock, join(userData, 'remotion-binaries-0.2.7'));
  assert.equal(binaries.hardware, join(userData, 'remotion-binaries-0.2.7-hardware'));
  assert.equal(await readFile(join(binaries.stock, 'ffmpeg.exe'), 'utf8'), 'limited',
    'ordinary renders keep the compositor ffmpeg, even where a pre-split swapped mirror stood');
  assert.equal(await readFile(join(binaries.hardware, 'ffmpeg.exe'), 'utf8'), 'nvenc-qsv-amf',
    'only the hardware attempt gets the static build');
  for (const directory of [binaries.stock, binaries.hardware]) {
    assert.equal(await readFile(join(directory, 'ffprobe.exe'), 'utf8'), 'probe');
    assert.equal(await readFile(join(directory, 'remotion.exe'), 'utf8'), 'compositor');
    assert.equal(await readFile(join(directory, 'avcodec.dll'), 'utf8'), 'dll');
  }
  assert.deepEqual(await ensureRemotionBinaries(windows), binaries, 'ready directories are reused');
  assert.equal(await readFile(join(binaries.stock, 'ffmpeg.exe'), 'utf8'), 'limited',
    'building the hardware mirror leaves the stock mirror untouched');

  // A new version replaces both Windows directories.
  const nextWindows = await ensureRemotionBinaries({ ...windows, version: '0.2.8' });
  assert.deepEqual(await readdir(userData).then((names) => names.sort()),
    ['remotion-binaries-0.2.8', 'remotion-binaries-0.2.8-hardware']);
  assert.equal(await readFile(join(nextWindows.stock, 'ffmpeg.exe'), 'utf8'), 'limited');

  // macOS/Linux: a faithful mirror, because the archive cannot be chmod'ed or spawned, so
  // the renderer must get a real, writable copy. ffmpeg stays the compositor's own, and the
  // hardware attempt renders from the same directory.
  const macCompositor = join(root, 'mac-compositor');
  const macUserData = join(root, 'mac-user-data');
  await mkdir(macCompositor, { recursive: true });
  await mkdir(macUserData, { recursive: true });
  await writeFile(join(macCompositor, 'remotion'), 'compositor');
  await writeFile(join(macCompositor, 'ffmpeg'), 'compositor-ffmpeg');
  await writeFile(join(macCompositor, 'ffprobe'), 'probe');
  await writeFile(join(macCompositor, 'libremotion.dylib'), 'dylib');
  const mac = { userDataPath: macUserData, version: '0.2.14', platform: 'darwin' as const, compositorDirectory: macCompositor, ffmpegPath: richFfmpeg };
  const macBinaries = await ensureRemotionBinaries(mac);
  assert.equal(macBinaries.stock, join(macUserData, 'remotion-binaries-0.2.14'));
  assert.equal(macBinaries.hardware, macBinaries.stock, 'only Windows has a separate hardware mirror');
  assert.equal(await readFile(join(macBinaries.stock, 'ffmpeg'), 'utf8'), 'compositor-ffmpeg', 'only Windows swaps ffmpeg');
  assert.equal(await readFile(join(macBinaries.stock, 'remotion'), 'utf8'), 'compositor');
  assert.equal(await readFile(join(macBinaries.stock, 'libremotion.dylib'), 'utf8'), 'dylib');
  assert.deepEqual(await ensureRemotionBinaries(mac), macBinaries);

  // A new version replaces the old directory.
  const next = await ensureRemotionBinaries({ ...mac, version: '0.2.15' });
  assert.equal(next.stock, join(macUserData, 'remotion-binaries-0.2.15'));
  await assert.rejects(readFile(join(macBinaries.stock, 'remotion')), 'the previous version directory is cleaned up');
} finally {
  await rm(root, { recursive: true, force: true });
}

// The packaged app hands each directory to the renderer under its own name: the stock
// mirror as the ordinary binaries directory, the hardware mirror for the hardware attempt.
const runtime = await readFile(new URL('./packaged-runtime.ts', import.meta.url), 'utf8');
assert.match(runtime, /process\.env\.CC_REMOTION_BINARIES_DIR = binaries\.stock;/, 'renders use the stock mirror');
assert.match(runtime, /process\.env\.CC_REMOTION_HARDWARE_BINARIES_DIR = binaries\.hardware;/, 'the hardware attempt gets its own mirror');

console.log('Remotion binaries verification passed (windows stock + hardware mirrors, mac mirror, version rollover)');
