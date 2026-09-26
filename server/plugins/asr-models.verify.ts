import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ASR_MODELS, asrModelEntry, asrModelFile, type AsrModelEntry } from '../../shared/asr-models';
import { ggmlCachePath, legacyGgmlCachePath, resolveGgmlPath } from '../../shared/asr-ggml-cache';
import { __resetAsrTasks, handleAsrModelsRequest, inspectAsrModel } from './asr-models';

const server = createServer((req, res) => {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  void handleAsrModelsRequest(req, res, pathname).catch((error) => {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const mutationPaths = ['/api/asr-models/download', '/api/asr-models/delete'] as const;

async function post(path: string, headers: HeadersInit, id = 'not-in-fixed-catalog'): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id }),
  });
}

try {
  for (const path of mutationPaths) {
    assert.equal((await post(path, {
      'Content-Type': 'application/json',
    })).status, 401, `${path} must reject a request without Origin`);
    assert.equal((await post(path, {
      Origin: 'http://evil.example',
      'Content-Type': 'application/json',
    })).status, 401, `${path} must require a trusted same-origin request`);
    assert.equal((await post(path, {
      Origin: origin,
      'Content-Type': 'text/plain',
    })).status, 415, `${path} must reject non-JSON content`);
    assert.equal((await post(path, {
      Origin: origin,
      'Content-Type': 'application/json',
    })).status, 400, `${path} must pass authorization and reject IDs outside the fixed catalog`);
  }
} finally {
  server.close();
  await once(server, 'close');
}

assert.deepEqual(ASR_MODELS.map((entry) => entry.revision), [
  '5332fcc35e32a33b86612b9a57a89be7906102b1',
  '608c49e61301901684bc36cac8f74b95ff6b5a8e',
  '2d67713f236afa48a18992566e7647f6ca848e13',
  '8c5b90880ab9f79487ab33613413431bf661d595',
  'b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a',
]);
for (const model of ASR_MODELS) {
  // tiny/base/small carry WebGPU fp16/fp32 variants (7 q8 files + encoder
  // fp16 + decoder fp16 + encoder fp32); medium and large-v3-turbo stay at
  // the plain q8 set (their fp32 encoders are 1.2GB / 2.5GB).
  const expectedFiles = model.id === 'medium' || model.id === 'large-v3-turbo' ? 7 : 10;
  assert.equal(model.files.length, expectedFiles);
  for (const file of model.files) {
    assert(file.sizeBytes > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(asrModelFile(model.modelId, model.revision, file.path), file);
  }
}

const tiny = asrModelEntry('tiny');
assert(tiny);
assert.equal(tiny.revision, '5332fcc35e32a33b86612b9a57a89be7906102b1');
assert.equal(
  asrModelFile(tiny.modelId, tiny.revision, 'config.json')?.sha256,
  '2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94',
);
assert.equal(asrModelFile(tiny.modelId, 'main', 'config.json'), undefined);
assert.equal(asrModelFile(tiny.modelId, tiny.revision, '../config.json'), undefined);

const root = await mkdtemp(join(tmpdir(), 'openchatcut-asr-integrity-'));
const expectedContent = Buffer.from('good');
const entry: AsrModelEntry = {
  id: 'tiny',
  modelId: 'test/asr-integrity',
  revision: 'a'.repeat(40),
  files: [{
    path: 'config.json',
    sizeBytes: expectedContent.length,
    sha256: createHash('sha256').update(expectedContent).digest('hex'),
  }],
  label: 'Test',
  sizeLabel: '4B',
  language: 'Test',
  note: 'Test',
};
try {
  const modelRoot = join(root, entry.modelId);
  await mkdir(modelRoot, { recursive: true });
  await writeFile(join(modelRoot, entry.files[0]!.path), 'baad');
  assert.deepEqual(await inspectAsrModel(entry, root), { downloaded: false, bytes: 0 },
    'same-size corrupted files must not count as downloaded');
  await writeFile(join(modelRoot, entry.files[0]!.path), expectedContent);
  __resetAsrTasks();
  assert.deepEqual(await inspectAsrModel(entry, root), { downloaded: true, bytes: expectedContent.length });
  const canceledInspection = new AbortController();  canceledInspection.abort(new DOMException('canceled', 'AbortError'));
  await assert.rejects(
    inspectAsrModel(entry, root, canceledInspection.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    'an aborted inspection must reject even when an integrity result is cached',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

// GGML companion files participate in the downloaded state: missing ggml
// keeps the tier not-downloaded even when every ONNX file is present.
{
  const ggmlRoot = join(root, 'ggml');
  const ggmlBytes = Buffer.from('ggml');
  const ggmlEntry: AsrModelEntry = {
    ...entry,
    ggmlFile: {
      fileName: 'ggml-test.bin',
      sizeBytes: ggmlBytes.length,
      sha256: createHash('sha256').update(ggmlBytes).digest('hex'),
      revision: 'b'.repeat(40),
    },
  };
  // The previous block removed the temp root; restore the ONNX file.
  await mkdir(join(root, ggmlEntry.modelId), { recursive: true });
  await writeFile(join(root, ggmlEntry.modelId, ggmlEntry.files[0]!.path), expectedContent);
  const onnxOnly = await inspectAsrModel(ggmlEntry, root);
  assert.equal(onnxOnly.downloaded, false, 'missing ggml file keeps the tier not downloaded');
  await mkdir(ggmlRoot, { recursive: true });
  await writeFile(join(ggmlRoot, ggmlEntry.ggmlFile!.fileName), ggmlBytes);
  const complete = await inspectAsrModel(ggmlEntry, root);
  assert.equal(complete.downloaded, true, 'onnx + ggml present counts as downloaded');
  assert.equal(complete.bytes, expectedContent.length + ggmlBytes.length, 'bytes include the ggml file');
}

// The GGML companion is written by the downloader and read by inspection and
// by the desktop whisper.cpp worker. Those must name the same file: a download
// that lands anywhere else leaves every GGML-bearing tier permanently
// "not downloaded" and silently disables the desktop native engine.
{
  const cacheDir = await mkdtemp(join(tmpdir(), 'asr-ggml-'));
  try {
    const fileName = 'ggml-companion-test.bin';
    assert.equal(
      ggmlCachePath(cacheDir, fileName),
      join(cacheDir, 'ggml', fileName),
      'the canonical companion path is <cache>/ggml/<file>',
    );
    assert.notEqual(
      legacyGgmlCachePath(cacheDir, fileName),
      ggmlCachePath(cacheDir, fileName),
      'the pre-fix hf-proxy layout is a different directory',
    );

    // A stranded legacy download is adopted in place rather than re-fetched.
    const legacy = legacyGgmlCachePath(cacheDir, fileName);
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, 'ggml-bytes');
    const adopted = resolveGgmlPath(cacheDir, fileName);
    assert.equal(adopted, ggmlCachePath(cacheDir, fileName));
    assert.equal(existsSync(adopted), true, 'the legacy companion is moved to the canonical path');
    assert.equal(existsSync(legacy), false, 'the legacy copy is not left behind');
    assert.equal(await readFile(adopted, 'utf8'), 'ggml-bytes', 'adoption preserves the bytes');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

// Every catalog companion must be a real whisper.cpp artifact name. A tier
// that names a file the upstream repo does not publish can never load
// natively, which is how `ggml-medium-q5_1.bin` disabled the medium tier.
for (const entry of ASR_MODELS) {
  if (!entry.ggmlFile) continue;
  const { fileName, sizeBytes, sha256, revision } = entry.ggmlFile;
  assert.match(fileName, /^ggml-[a-z0-9._-]+\.bin$/, `${entry.id}: implausible ggml file name ${fileName}`);
  assert.ok(sizeBytes > 0, `${entry.id}: ggml size must be positive`);
  assert.match(sha256, /^[a-f0-9]{64}$/, `${entry.id}: ggml sha256 must be a lowercase digest`);
  assert.match(revision, /^[a-f0-9]{40}$/, `${entry.id}: ggml revision must be a pinned commit`);
}

// The tiers the desktop engine is expected to serve must all carry a companion,
// otherwise they silently fall back to the browser wasm engine.
for (const id of ['tiny', 'base', 'small', 'medium', 'large-v3-turbo']) {
  assert.ok(asrModelEntry(id)?.ggmlFile, `tier ${id} must record a GGML companion for the desktop engine`);
}

console.log('asr-models.verify: mutation authorization and JSON contract OK');
