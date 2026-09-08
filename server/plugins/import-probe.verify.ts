// A download that is not the media its name promises must fail at import time, and a
// readable one must come back with the measurements the agent needs — without a second
// tool call. Files ffprobe was never expected to read (svg, lut, bin) pass through.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { ffprobeExpected, probeImportedFile } from './import-probe.ts';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1000)))));
  });
}

assert.equal(ffprobeExpected('clip.MP4'), true);
assert.equal(ffprobeExpected('song.mp3'), true);
assert.equal(ffprobeExpected('logo.svg'), false);
assert.equal(ffprobeExpected('grade.cube'), false);
assert.equal(ffprobeExpected('unknown.bin'), false);

const work = await mkdtemp(join(tmpdir(), 'import-probe-'));
try {
  const tone = join(work, 'tone.wav');
  await run(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone]);
  const readable = await probeImportedFile(tone, 'tone.wav');
  assert.ok('probe' in readable && readable.probe, 'a real wav yields a probe');
  assert.equal(readable.probe.hasAudioTrack, true);
  assert.equal(readable.probe.hasVideoTrack, false);
  assert.ok(readable.probe.durationSeconds && Math.abs(readable.probe.durationSeconds - 1) < 0.1);

  const html = join(work, 'page.mp4');
  await writeFile(html, '<!doctype html><title>blocked</title>');
  const rejected = await probeImportedFile(html, 'page.mp4');
  assert.ok('error' in rejected, 'an HTML page saved as .mp4 is rejected');
  assert.match(rejected.error, /not readable mp4/);

  const svg = join(work, 'logo.svg');
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.deepEqual(await probeImportedFile(svg, 'logo.svg'), { probe: null }, 'svg is not ffprobe territory (it would read as a 0×0 video)');

  const bin = join(work, 'blob.bin');
  await writeFile(bin, 'opaque');
  assert.deepEqual(await probeImportedFile(bin, 'blob.bin'), { probe: null }, 'unknown bytes pass through');
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('import-probe checks passed (readable wav, html-as-mp4 rejected, svg/bin pass through)');
