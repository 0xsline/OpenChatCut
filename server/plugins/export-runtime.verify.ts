import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { exportScale } from './export-plan.ts';
import {
  cancelActiveExportJob,
  cleanupStaleExportFiles,
  exportJobFilename,
  forgetExportJobController,
  finalH264EncoderOutcome,
  exportOutputSize,
  resolveMaxActiveExports,
  retimeFps,
  retimeVideoEncodingArgs,
  trackExportJobController,
} from './export-runtime.ts';
import { createGenerationJob, getGenerationJobSnapshot } from './generation-jobs.ts';

assert.equal(resolveMaxActiveExports(undefined), 1);
assert.equal(resolveMaxActiveExports('invalid'), 1);
assert.equal(resolveMaxActiveExports('0'), 1);
assert.equal(resolveMaxActiveExports('2'), 2);
assert.equal(resolveMaxActiveExports('99'), 4);
assert.deepEqual(
  exportOutputSize({ width: 1920, height: 1080 }, exportScale({ width: 1920, height: 1080 }, '480p')),
  { width: 854, height: 480 },
);

assert.deepEqual(
  retimeVideoEncodingArgs('vp8', 'libx264', 12_000_000),
  ['-c:v', 'libvpx', '-b:v', '12000000'],
);
for (const encoder of ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'libx264'] as const) {
  const args = retimeVideoEncodingArgs('h264', encoder, 12_000_000);
  assert.equal(args[args.indexOf('-b:v') + 1], '12000000', `${encoder} retime keeps the selected bitrate`);
}

const software = {
  encoder: {
    id: 'libx264' as const,
    label: 'Software (libx264)',
    hardware: false,
    transport: 'server' as const,
  },
  encoderFallbackReason: 'h264_nvenc: device-unavailable',
};
const nvenc = {
  encoder: {
    id: 'h264_nvenc' as const,
    label: 'NVIDIA NVENC',
    hardware: true,
    transport: 'server' as const,
  },
};
assert.deepEqual(finalH264EncoderOutcome(software, undefined), software);
assert.deepEqual(finalH264EncoderOutcome(software, nvenc), nvenc, 'successful retime clears stale fallback');
assert.deepEqual(
  finalH264EncoderOutcome(software, { encoder: software.encoder }),
  software,
  'software retime preserves the sanitized render fallback',
);
assert.deepEqual(
  finalH264EncoderOutcome(nvenc, {
    encoder: software.encoder,
    encoderFallbackReason: 'h264_qsv: initialization-failed',
  }),
  {
    encoder: software.encoder,
    encoderFallbackReason: 'h264_qsv: initialization-failed',
  },
);

const exportDir = await mkdtemp(join(tmpdir(), 'openchatcut-export-cleanup-'));
try {
  const now = Date.now();
  const staleName = exportJobFilename('00000000-0000-4000-8000-000000000001', 'mp4');
  const freshName = exportJobFilename('00000000-0000-4000-8000-000000000002', 'webm');
  const unrelatedName = 'user-owned-video.mp4';
  const prefixedUserName = 'openchatcut-export-job-project.mp4';
  await Promise.all([
    writeFile(join(exportDir, staleName), 'stale export'),
    writeFile(join(exportDir, freshName), 'fresh export'),
    writeFile(join(exportDir, unrelatedName), 'user media'),
    writeFile(join(exportDir, prefixedUserName), 'user media with reserved-looking prefix'),
  ]);
  const staleDate = new Date(now - 2 * 60 * 60_000);
  await utimes(join(exportDir, staleName), staleDate, staleDate);
  await utimes(join(exportDir, prefixedUserName), staleDate, staleDate);

  const removed = await cleanupStaleExportFiles(exportDir, { now, retentionMs: 60 * 60_000 });
  assert.equal(removed, 1);
  assert.equal(existsSync(join(exportDir, staleName)), false, 'stale temporary export should be removed');
  assert.equal(existsSync(join(exportDir, freshName)), true, 'fresh temporary export should be retained');
  assert.equal(existsSync(join(exportDir, unrelatedName)), true, 'user media must never be swept');
  assert.equal(existsSync(join(exportDir, prefixedUserName)), true, 'non-UUID user media must never be swept');
} finally {
  await rm(exportDir, { recursive: true, force: true });
}

const staleOutput = join(tmpdir(), `openchatcut-retime-check-${randomUUID()}.mp4`);
await writeFile(staleOutput, 'stale partial output');
await assert.rejects(
  retimeFps('/definitely/missing/openchatcut-input.mp4', staleOutput, 30, 'vp8', 4_000_000),
  /ffmpeg fps retime failed/,
);
assert.equal(existsSync(staleOutput), false, 'failed FPS conversion must remove partial output');

const controller = new AbortController();
const { jobId } = createGenerationJob(
  { kind: 'export-cancellation-check' },
  async () => {
    controller.signal.throwIfAborted();
    return new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
  },
  { onSettled: forgetExportJobController },
);
trackExportJobController(jobId, controller);
assert.equal(await cancelActiveExportJob(jobId), true);
assert.equal(getGenerationJobSnapshot(jobId), undefined);

console.log('export runtime checks passed');
