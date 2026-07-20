import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveMaxActiveExports, retimeFps } from './export-runtime.ts';

assert.equal(resolveMaxActiveExports(undefined), 1);
assert.equal(resolveMaxActiveExports('invalid'), 1);
assert.equal(resolveMaxActiveExports('0'), 1);
assert.equal(resolveMaxActiveExports('2'), 2);
assert.equal(resolveMaxActiveExports('99'), 4);

const staleOutput = join(tmpdir(), `openchatcut-retime-check-${randomUUID()}.mp4`);
await writeFile(staleOutput, 'stale partial output');
await assert.rejects(
  retimeFps('/definitely/missing/openchatcut-input.mp4', staleOutput, 30, 'vp8', 4_000_000),
  /ffmpeg fps retime failed/,
);
assert.equal(existsSync(staleOutput), false, 'failed FPS conversion must remove partial output');

console.log('export runtime checks passed');
