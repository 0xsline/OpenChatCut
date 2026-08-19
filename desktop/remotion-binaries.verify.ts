import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureWindowsRemotionBinaries } from './remotion-binaries.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-remotion-binaries-'));
try {
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

  const destination = await ensureWindowsRemotionBinaries({
    userDataPath: userData,
    version: '0.2.7',
    platform: 'win32',
    compositorDirectory: compositor,
    ffmpegPath: richFfmpeg,
  });
  assert.equal(destination, join(userData, 'remotion-binaries-0.2.7'));
  assert.equal(await readFile(join(destination!, 'ffmpeg.exe'), 'utf8'), 'nvenc-qsv-amf');
  assert.equal(await readFile(join(destination!, 'ffprobe.exe'), 'utf8'), 'probe');
  assert.equal(await readFile(join(destination!, 'remotion.exe'), 'utf8'), 'compositor');
  assert.equal(await readFile(join(destination!, 'avcodec.dll'), 'utf8'), 'dll');
  assert.equal(await ensureWindowsRemotionBinaries({
    userDataPath: userData,
    version: '0.2.7',
    platform: 'win32',
    compositorDirectory: compositor,
    ffmpegPath: richFfmpeg,
  }), destination);
  assert.equal(await ensureWindowsRemotionBinaries({
    userDataPath: userData,
    version: '0.2.7',
    platform: 'darwin',
  }), null);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('Windows Remotion binaries verification passed');
