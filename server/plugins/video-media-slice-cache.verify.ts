// Regression gate for the timeline-slice derivative cache.
//
// ffmpeg used to encode straight to the cache name, so an encode killed at the
// 5-minute timeout left a truncated mp4 there; the cache gate was existence-only,
// so that corrupt file was then handed to a paid video provider forever (via a
// presigned URL) and nothing ever cleared it. These checks pin both halves:
// a failed encode publishes nothing, and an existing corrupt entry is rejected.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedKeystore } from '../keystore.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { materializeVideoReferences } from './video-media.ts';

const directory = await mkdtemp(join(tmpdir(), 'occ-slice-cache-'));
const previousFfmpeg = process.env.OPENCHATCUT_FFMPEG;
const source = join(directory, 'master.mp4');
const stub = join(directory, 'stub-ffmpeg');
const marker = join(directory, 'stub-ran');

try {
  const generated = spawnSync(ffmpegBin(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', source,
  ], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  seedKeystore({ MEDIA_DIR: directory });

  // 1. A successful encode publishes a decodable slice under the cache name.
  const ok = await slice({ srcOutFrame: 30 });
  const published = join(directory, ok.replace('/media/uploads/', ''));
  assert.ok((await readdir(directory)).includes(ok.replace('/media/uploads/', '')), 'a completed slice is published');
  assert.equal((await stat(published)).size > 0, true);
  assert.ok((duration(published) ?? 0) > 0, 'the published slice decodes');

  // 2. A truncated slice already sitting at the cache name (what a killed encode
  //    used to leave) must be rejected and rebuilt, not reused.
  await truncate(published, 48);
  assert.equal(duration(published), null, 'the fixture really is a corrupt mp4');
  const rebuilt = await slice({ srcOutFrame: 30 });
  assert.equal(rebuilt, ok);
  assert.ok((await stat(published)).size > 48, 'a corrupt cache entry must be re-encoded');
  assert.ok((duration(published) ?? 0) > 0, 'the rebuilt slice decodes');

  // 3. An encode that dies mid-write must publish nothing at the cache name.
  await writeFile(stub, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('-i')) process.exit(0);
writeFileSync(${JSON.stringify(marker)}, 'ran');
writeFileSync(args[args.length - 1], Buffer.alloc(20, 7));
process.exit(1);
`);
  await chmod(stub, 0o755);
  process.env.OPENCHATCUT_FFMPEG = stub;
  const before = (await readdir(directory)).sort();
  await assert.rejects(
    () => slice({ srcOutFrame: 60 }),
    /failed to materialize generation timeline slice/,
  );
  assert.ok((await readdir(directory)).includes('stub-ran'), 'the stub encoder really ran');
  const published2 = (await readdir(directory)).sort();
  assert.deepEqual(
    published2.filter((name) => !before.includes(name) && name !== 'stub-ran'),
    [],
    'a failed encode must publish nothing, not even a temp file',
  );
} finally {
  if (previousFfmpeg === undefined) delete process.env.OPENCHATCUT_FFMPEG;
  else process.env.OPENCHATCUT_FFMPEG = previousFfmpeg;
  await rm(directory, { recursive: true, force: true });
}

function reference(options: { srcOutFrame: number }) {
  return {
    kind: 'timeline-slice',
    role: 'reference-video',
    assetId: 'asset-1',
    path: '/media/uploads/master.mp4',
    srcInFrame: 0,
    srcOutFrame: options.srcOutFrame,
    playbackRate: 1,
    fps: 30,
    timelineDurationInFrames: options.srcOutFrame,
  };
}

async function slice(options: { srcOutFrame: number }): Promise<string> {
  const materialized = await materializeVideoReferences({
    model: 'kling',
    generationReferences: [reference(options)],
  } as never);
  return materialized.refVideoPaths![0]!;
}

/** Decodable duration, or null — the same bar the cache gate applies. */
function duration(file: string): number | null {
  const probed = spawnSync(ffprobeBin(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8' });
  if (probed.status !== 0) return null;
  const seconds = Number(probed.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

console.log('timeline slice cache verification passed');
