import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  // Windows: the compositor's limited ffmpeg is swapped for the richer static build.
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

  const windows = { userDataPath: userData, version: '0.2.7', platform: 'win32' as const, compositorDirectory: compositor, ffmpegPath: richFfmpeg };
  const destination = await ensureRemotionBinaries(windows);
  assert.equal(destination, join(userData, 'remotion-binaries-0.2.7'));
  assert.equal(await readFile(join(destination, 'ffmpeg.exe'), 'utf8'), 'nvenc-qsv-amf');
  assert.equal(await readFile(join(destination, 'ffprobe.exe'), 'utf8'), 'probe');
  assert.equal(await readFile(join(destination, 'remotion.exe'), 'utf8'), 'compositor');
  assert.equal(await readFile(join(destination, 'avcodec.dll'), 'utf8'), 'dll');
  assert.equal(await ensureRemotionBinaries(windows), destination, 'a ready directory is reused');

  // macOS/Linux: a faithful mirror — the archive cannot be chmod'ed or spawned, so the
  // renderer must get a real, writable copy; ffmpeg stays the compositor's own.
  const macCompositor = join(root, 'mac-compositor');
  const macUserData = join(root, 'mac-user-data');
  await mkdir(macCompositor, { recursive: true });
  await mkdir(macUserData, { recursive: true });
  await writeFile(join(macCompositor, 'remotion'), 'compositor');
  await writeFile(join(macCompositor, 'ffmpeg'), 'compositor-ffmpeg');
  await writeFile(join(macCompositor, 'ffprobe'), 'probe');
  await writeFile(join(macCompositor, 'libremotion.dylib'), 'dylib');
  const mac = { userDataPath: macUserData, version: '0.2.14', platform: 'darwin' as const, compositorDirectory: macCompositor, ffmpegPath: richFfmpeg };
  const macDestination = await ensureRemotionBinaries(mac);
  assert.equal(macDestination, join(macUserData, 'remotion-binaries-0.2.14'));
  assert.equal(await readFile(join(macDestination, 'ffmpeg'), 'utf8'), 'compositor-ffmpeg', 'only Windows swaps ffmpeg');
  assert.equal(await readFile(join(macDestination, 'remotion'), 'utf8'), 'compositor');
  assert.equal(await readFile(join(macDestination, 'libremotion.dylib'), 'utf8'), 'dylib');
  assert.equal(await ensureRemotionBinaries(mac), macDestination);

  // A new version replaces the old directory.
  const next = await ensureRemotionBinaries({ ...mac, version: '0.2.15' });
  assert.equal(next, join(macUserData, 'remotion-binaries-0.2.15'));
  await assert.rejects(readFile(join(macDestination, 'remotion')), 'the previous version directory is cleaned up');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Remotion binaries verification passed (windows ffmpeg swap, mac mirror, version rollover)');
