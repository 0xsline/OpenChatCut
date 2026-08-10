import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASR_MODELS } from '../../shared/asr-models';
import {
  downloadModelFile,
  handleHfProxyRequest,
  mergeDownloadedParts,
  modelCacheDir,
  parseTarget,
  settlePartDownloadRound,
  sourceMissingOnError,
  __getAbsentSourcesForVerify,
  __resetModelMissingState,
  type PartStreamFactory,
  type ProxyTarget,
} from './hf-proxy';
import { openVerifiedFile } from './hf-integrity';

const RHYTHM_REVISION = '4e971bd43753023e1bf961c34a0cb74985cfcb88';
const CLAP_REVISION = 'c28f2883575e590e04d3146ff0713c2448d691ba';
const rhythmPath = `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/beat_this.onnx`;

assert.deepEqual(parseTarget(rhythmPath), {
  modelId: 'musetric/beat-this-onnx',
  revision: RHYTHM_REVISION,
  filePath: 'beat_this.onnx',
});
assert.deepEqual(
  parseTarget(`/Xenova/clap-htsat-unfused/resolve/${CLAP_REVISION}/onnx/audio_model_quantized.onnx`),
  {
    modelId: 'Xenova/clap-htsat-unfused',
    revision: CLAP_REVISION,
    filePath: 'onnx/audio_model_quantized.onnx',
  },
);

const asrModel = ASR_MODELS[0];
const asrFile = asrModel.files[0];
const asrPath = `/${asrModel.modelId}/resolve/${asrModel.revision}/${asrFile.path}`;
assert.deepEqual(parseTarget(asrPath), {
  modelId: asrModel.modelId,
  revision: asrModel.revision,
  filePath: asrFile.path,
});

// transformers.js v4 probes config files with revision "main"; it must resolve
// to the catalog-pinned revision (same sha-verified file tuple).
assert.deepEqual(parseTarget(`/${asrModel.modelId}/resolve/main/${asrFile.path}`), {
  modelId: asrModel.modelId,
  revision: asrModel.revision,
  filePath: asrFile.path,
});

const rejectedPaths = [
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/%`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/.`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/..`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/%2e%2e`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}//beat_this.onnx`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/onnx%2F..%2Fbeat_this.onnx`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/onnx%5C..%5Cbeat_this.onnx`,
  `/musetric/beat-this-onnx/resolve/main/beat_this.onnx`,
  `/musetric/beat-this-onnx/resolve/${RHYTHM_REVISION}/not-in-catalog.onnx`,
  `/unlisted/repository/resolve/${RHYTHM_REVISION}/beat_this.onnx`,
  `/${asrModel.modelId}/resolve/${'0'.repeat(40)}/${asrFile.path}`,
  `/${asrModel.modelId}/resolve/${asrModel.revision}/not-in-catalog.json`,
];
for (const path of rejectedPaths) assert.equal(parseTarget(path), null, path);

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-hf-proxy-'));
const destination = join(directory, 'merged.bin');
const chunks: Record<string, readonly Buffer[]> = {
  first: [Buffer.from('one'), Buffer.from('-')],
  second: [Buffer.from('two')],
  third: [Buffer.from('-three')],
};
const opened: string[] = [];
let activeStreams = 0;
let maximumActiveStreams = 0;
const streamFactory: PartStreamFactory = async function* (path) {
  opened.push(path);
  activeStreams += 1;
  maximumActiveStreams = Math.max(maximumActiveStreams, activeStreams);
  try {
    for (const chunk of chunks[path] ?? []) yield chunk;
  } finally {
    activeStreams -= 1;
  }
};

await mergeDownloadedParts(['first', 'second', 'third'], destination, 13, streamFactory);
assert.equal((await readFile(destination)).toString('utf8'), 'one-two-three');
assert.deepEqual(opened, ['first', 'second', 'third']);
assert.equal(maximumActiveStreams, 1, 'part streams must be consumed sequentially');

const expectedFailure = new Error('part failed');
let releaseSlowPart: (() => void) | undefined;
const slowPart = new Promise<void>((resolve) => { releaseSlowPart = resolve; });
let roundSettled = false;
const round = settlePartDownloadRound([
  async () => { throw expectedFailure; },
  async () => { await slowPart; },
]);
void round.then(() => { roundSettled = true; });
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(roundSettled, false, 'a failed part must not start a new round while sibling curls still run');
releaseSlowPart?.();
assert.equal(await round, expectedFailure);

const fixture = Buffer.from('fixture-good');
const corruptFixture = Buffer.from('fixture-evil');
assert.equal(fixture.length, corruptFixture.length);
const fixtureIntegrity = {
  sizeBytes: fixture.length,
  sha256: createHash('sha256').update(fixture).digest('hex'),
};
const servedPath = join(directory, 'served-asr.json');
await writeFile(servedPath, fixture);
const corruptPath = join(directory, 'corrupt-asr.json');
await writeFile(corruptPath, corruptFixture);
assert.equal(await openVerifiedFile(corruptPath, fixtureIntegrity), null);

const asrTarget: ProxyTarget = {
  modelId: asrModel.modelId,
  revision: asrModel.revision,
  filePath: asrFile.path,
};
const downloadTarget: ProxyTarget = {
  modelId: 'test/fixture',
  revision: 'pinned',
  filePath: 'fixture.json',
};
const cachedDownload = join(directory, 'cached-download.json');
await writeFile(cachedDownload, fixture);
assert.equal(await downloadModelFile(downloadTarget, cachedDownload, {
  expectedBytes: fixtureIntegrity.sizeBytes,
  expectedSha256: fixtureIntegrity.sha256,
}), cachedDownload);
await writeFile(cachedDownload, corruptFixture);
const aborted = new AbortController();
aborted.abort(new Error('do not access the network'));
await assert.rejects(
  downloadModelFile(downloadTarget, cachedDownload, {
    signal: aborted.signal,
    expectedBytes: fixtureIntegrity.sizeBytes,
    expectedSha256: fixtureIntegrity.sha256,
  }),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);
await assert.rejects(stat(cachedDownload), { code: 'ENOENT' });
await assert.rejects(stat(`${cachedDownload}.part`), { code: 'ENOENT' });

// A deterministic mirror-absence failure must be classified "source missing"
// so the next file of the same model can skip that source wholesale.
assert.equal(sourceMissingOnError(new Error('model download failed (curl exit 22): ... returned error: 404')), true);
assert.equal(sourceMissingOnError(new Error('invalid content-range: {"Code":10990101007,"Message":"获取模型文件失败，文件内容为空"}')), true);
// Transient failures and unrelated HTTP errors must NOT be treated as absence
// (a 502 makes curl exit 22 too, but it is not a 404; a timeout is exit 28).
assert.equal(sourceMissingOnError(new Error('model download failed (curl exit 28): Operation timed out')), false);
assert.equal(sourceMissingOnError(new Error('model download failed (curl exit 22): The requested URL returned error: 502')), false);
assert.equal(sourceMissingOnError(null), false);
assert.equal(sourceMissingOnError('not an error'), false);
// The session-scoped cache must be empty until a source is marked absent, and
// a reset clears it (mirrors __resetModelPackState driving a fresh session).
__resetModelMissingState();

// Integration: the real download loop must record a mirror that deterministically
// 404s for a model as "absent" for that modelId, so later files of the same model
// skip it. rhythm-lite (musetric/beat-this-onnx) is NOT on ModelScope but IS on
// HuggingFace; config.json is tiny (~1KB) so this completes quickly. The download
// 404s on ModelScope first (marking it absent), then falls through to HF.
if (!process.env.HF_PROXY_SKIP_INTEGRATION) {
  const integrationDir = await mkdtemp(join(tmpdir(), 'openchatcut-hf-proxy-integration-'));
  try {
    __resetModelMissingState();
    const tinyDestination = join(integrationDir, 'config.json');
    await downloadModelFile(
      { modelId: 'musetric/beat-this-onnx', revision: RHYTHM_REVISION, filePath: 'config.json' },
      tinyDestination,
    );
    const absent = __getAbsentSourcesForVerify().get('musetric/beat-this-onnx') ?? [];
    assert.equal(
      absent.includes('modelscope'),
      true,
      `ModelScope must be recorded absent for a mirrored-but-404 model; got: ${[...absent]}`,
    );
  } finally {
    await rm(integrationDir, { recursive: true, force: true });
  }
}

const originalHome = process.env.HOME;
process.env.HOME = directory;
assert.equal(modelCacheDir(), join(directory, '.openchatcut', 'asr-models'));
const resolveInstalled = async (target: ProxyTarget) => {
  if (target.modelId !== asrTarget.modelId
    || target.revision !== asrTarget.revision
    || target.filePath !== asrTarget.filePath) return null;
  const verified = await openVerifiedFile(servedPath, fixtureIntegrity);
  return verified ? { ...verified, path: servedPath } : null;
};
const server = createServer((req, res) => {
  void handleHfProxyRequest(req, res, resolveInstalled).catch((error) => {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
try {
  const asrGet = await fetch(`http://127.0.0.1:${address.port}${asrPath}`);
  assert.equal(asrGet.status, 200);
  assert.equal(await asrGet.text(), fixture.toString());
  const asrHead = await fetch(`http://127.0.0.1:${address.port}${asrPath}`, { method: 'HEAD' });
  assert.equal(asrHead.status, 200);
  assert.equal(asrHead.headers.get('content-length'), String(fixture.length));
  assert.equal(await asrHead.text(), '');
  await writeFile(servedPath, corruptFixture);
  await utimes(servedPath, new Date(), new Date(Date.now() + 1_000));
  const corruptGet = await fetch(`http://127.0.0.1:${address.port}${asrPath}`);
  assert.equal(corruptGet.status, 404, 'same-size files with the wrong SHA-256 must not be served');
  const absent = await fetch(`http://127.0.0.1:${address.port}${rhythmPath}`);
  assert.equal(absent.status, 404, 'an unauthenticated read cannot download a missing catalog file');
  const arbitrary = await fetch(
    `http://127.0.0.1:${address.port}/unlisted/repository/resolve/${RHYTHM_REVISION}/model.onnx`,
  );
  assert.equal(arbitrary.status, 400);
  await assert.rejects(stat(modelCacheDir()), { code: 'ENOENT' });
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(directory, { recursive: true, force: true });
}

console.log('hf-proxy.verify: ok');
