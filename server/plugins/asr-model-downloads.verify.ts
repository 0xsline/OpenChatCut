// The GGML companion is written by the download routine and read by the
// inspection, deleteModel, and the desktop worker. v0.2.2–v0.2.14 downloaded it
// without a destination, so hf-proxy filed it under the source repo path and
// every GGML tier read as "not downloaded". resolveGgmlPath now adopts such
// stranded copies, which would hide the same mistake from an
// inspect-after-download check, so these checks pin the destination itself.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ASR_MODELS, type AsrModelEntry } from '../../shared/asr-models';
import { GGML_SOURCE_MODEL_ID, ggmlCachePath, legacyGgmlCachePath } from '../../shared/asr-ggml-cache';
import {
  __downloadAsrModelForVerify, __resetAsrTasks, asrModelDownloads, inspectAsrModel,
} from './asr-models';
import type { downloadModelFile, ProxyTarget } from './hf-proxy';

/** Where hf-proxy files a download that names no destination. */
function hfProxyDefaultPath(cacheDir: string, target: ProxyTarget): string {
  return join(cacheDir, target.modelId, ...target.filePath.split('/'));
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// Every catalog tier: ONNX files land where inspection and the hf-proxy file
// server read them, the companion lands in <cache>/ggml/.
{
  const cacheDir = join(tmpdir(), 'openchatcut-asr-download-plan');
  for (const entry of ASR_MODELS) {
    const downloads = asrModelDownloads(entry, cacheDir);
    assert.equal(downloads.length, entry.files.length + (entry.ggmlFile ? 1 : 0), `${entry.id}: every file is planned`);
    entry.files.forEach((file, index) => {
      const planned = downloads[index]!;
      assert.deepEqual(planned.target, { modelId: entry.modelId, revision: entry.revision, filePath: file.path });
      assert.equal(planned.destination, join(cacheDir, entry.modelId, file.path), `${entry.id}: ${file.path} destination`);
      assert.deepEqual([planned.sizeBytes, planned.sha256], [file.sizeBytes, file.sha256]);
    });
    const ggml = entry.ggmlFile;
    if (!ggml) continue;
    const companion = downloads.at(-1)!;
    assert.deepEqual(companion.target, {
      modelId: GGML_SOURCE_MODEL_ID, revision: ggml.revision, filePath: ggml.fileName,
    });
    assert.equal(companion.destination, ggmlCachePath(cacheDir, ggml.fileName),
      `${entry.id}: the companion must land where the readers look`);
    assert.notEqual(companion.destination, hfProxyDefaultPath(cacheDir, companion.target),
      `${entry.id}: the companion must not be left to hf-proxy's repo-derived layout`);
    assert.deepEqual([companion.sizeBytes, companion.sha256], [ggml.sizeBytes, ggml.sha256]);
  }
}

// The download routine hands exactly those destinations to the transport.
{
  const cacheDir = await mkdtemp(join(tmpdir(), 'openchatcut-asr-download-'));
  const onnx = Buffer.from('synthetic-onnx');
  const ggml = Buffer.from('synthetic-ggml');
  const entry: AsrModelEntry = {
    id: 'tiny',
    modelId: 'fixture/asr-download',
    revision: 'a'.repeat(40),
    files: [{ path: 'onnx/model.onnx', sizeBytes: onnx.length, sha256: sha256(onnx) }],
    ggmlFile: { fileName: 'ggml-fixture.bin', sizeBytes: ggml.length, sha256: sha256(ggml), revision: 'b'.repeat(40) },
    label: 'Fixture', sizeLabel: 'fixture', language: 'fixture', note: 'fixture',
  };
  const destinations: Array<string | undefined> = [];
  const transport: typeof downloadModelFile = async (target, destination) => {
    destinations.push(destination);
    // Behave like hf-proxy: an omitted destination falls back to the repo layout.
    const path = destination ?? hfProxyDefaultPath(cacheDir, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, target.modelId === GGML_SOURCE_MODEL_ID ? ggml : onnx);
    return path;
  };
  try {
    const task = await __downloadAsrModelForVerify(entry, cacheDir, transport);
    assert.deepEqual(destinations, asrModelDownloads(entry, cacheDir).map((file) => file.destination),
      'every file must be downloaded to its planned destination');
    const fileName = entry.ggmlFile!.fileName;
    assert.equal(existsSync(ggmlCachePath(cacheDir, fileName)), true, 'the companion is written to <cache>/ggml/');
    assert.equal(existsSync(legacyGgmlCachePath(cacheDir, fileName)), false, 'nothing is written to the stranded layout');
    assert.deepEqual([task.filesDone, task.bytesDone], [2, onnx.length + ggml.length]);

    __resetAsrTasks();
    assert.equal((await inspectAsrModel(entry, cacheDir)).downloaded, true,
      'the files the downloader writes are the files inspection verifies');

    await __downloadAsrModelForVerify(entry, cacheDir, transport);
    assert.equal(destinations.length, 2, 'verified files are not downloaded again');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

console.log('asr-model-downloads.verify: every download lands where its readers look');
