import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin } from './media-binaries.ts';
import { normalizeMediaFile } from './media-normalization-runner.ts';
import { sha256File } from '../shared/node-content-hash.ts';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'openchatcut-normalize-reference-'));
const source = join(root, 'external-source.avi');
const output = join(root, 'managed', 'normalized.mp4');

try {
  await mkdir(join(root, 'managed'), { recursive: true });
  await run(ffmpegBin(), [
    '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=0.2',
    '-c:v', 'mpeg4', source,
  ]);
  const sourceHash = await sha256File(source);
  const result = await normalizeMediaFile({
    inputPath: source,
    publicSrc: '/media/uploads/reference.avi',
    outputPath: output,
    preserveInput: true,
    force: true,
    publishR2: false,
    uploadsDirectory: join(root, 'managed'),
  });
  assert.equal(result.outputPath, output);
  assert.equal(result.normalized, true);
  assert.equal(await sha256File(source), sourceHash, 'normalization must never replace an external source');
  await assert.doesNotReject(access(output));
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('media-normalization-reference.verify: external input preserved and managed output created\n');
