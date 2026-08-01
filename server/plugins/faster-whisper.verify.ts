import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { KEY_NAMES, seedKeystore } from '../keystore.ts';
import {
  fasterWhisperRuntimeRoot,
  fasterWhisperStatusSync,
  runFasterWhisperTranscription,
  startFasterWhisperInstall,
} from './faster-whisper.ts';

const runtime = join('/tmp', `openchatcut-fw-runtime-${process.pid}`);
const mediaDir = join('/tmp', `openchatcut-fw-media-${process.pid}`);
process.env.OPENCHATCUT_RUNTIME_DIR = runtime;

const isolatedSeed = Object.fromEntries(KEY_NAMES.map((name) => [name, '']));
seedKeystore({
  ...isolatedSeed,
  MEDIA_DIR: mediaDir,
  FASTER_WHISPER_MODEL: 'small',
  FASTER_WHISPER_COMPUTE_TYPE: 'int8',
} as Record<string, string>);

function fakeChild(stdoutText = ''): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdout,
    stderr,
    stdin: new PassThrough(),
    kill: () => true,
  });
  queueMicrotask(() => {
    if (stdoutText) stdout.write(stdoutText);
    stdout.end();
    stderr.end();
    child.emit('close', 0);
  });
  return child;
}

function waitForJob(job: { status: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (job.status !== 'running') { resolve(); return; }
      if (Date.now() - started > 2000) { reject(new Error('install job did not finish')); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

await rm(runtime, { recursive: true, force: true });
await rm(mediaDir, { recursive: true, force: true });
await mkdir(mediaDir, { recursive: true });

const fakeSpawnSync: typeof spawnSync = (() => ({ status: 0 })) as typeof spawnSync;
const fakeSpawn: typeof spawn = ((command: string, args: readonly string[]) => {
  if (args.includes('venv')) {
    const bin = process.platform === 'win32'
      ? join(fasterWhisperRuntimeRoot(), 'venv', 'Scripts')
      : join(fasterWhisperRuntimeRoot(), 'venv', 'bin');
    void mkdir(bin, { recursive: true }).then(() => writeFile(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), 'python'));
  }
  const out = String(args[0]).endsWith('transcribe.py') || args.includes('--prepare')
    ? '{"text":"你好世界","words":[{"text":"你好","start":0,"end":320},{"text":"世界","start":360,"end":700}]}\n'
    : '';
  return fakeChild(out);
}) as typeof spawn;

const job = startFasterWhisperInstall({ model: 'small', computeType: 'int8' }, { spawn: fakeSpawn, spawnSync: fakeSpawnSync });
await waitForJob(job);
assert.equal(job.status, 'succeeded');
assert.equal(fasterWhisperStatusSync('small').installed, true);
assert.ok(existsSync(join(runtime, 'faster-whisper', 'models', 'small.ready.json')));

await writeFile(join(mediaDir, 'sample.wav'), 'audio');
const result = await runFasterWhisperTranscription(
  { src: '/media/uploads/sample.wav', model: 'small', computeType: 'int8', languageCode: 'zh' },
  { spawn: fakeSpawn },
);
assert.equal(result.text, '你好世界');
assert.deepEqual(result.words, [
  { text: '你好', start: 0, end: 320, speaker: null },
  { text: '世界', start: 360, end: 700, speaker: null },
]);
assert.deepEqual(result.utterances, []);

await rm(runtime, { recursive: true, force: true });
await rm(mediaDir, { recursive: true, force: true });

console.log('faster-whisper.verify: ok');
