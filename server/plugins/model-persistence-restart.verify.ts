import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AsrModelEntry } from '../../shared/asr-models.ts';
import { modelCachePath } from '../../shared/model-cache-path.ts';
import type { ModelPackDefinition } from '../../shared/model-packs/catalog.ts';
import { inspectAsrModel } from './asr-models.ts';
import { __inspectModelPackForVerify } from './model-packs.ts';

interface ProbeConfig {
  readonly cacheDir: string;
  readonly asr: AsrModelEntry;
  readonly pack: ModelPackDefinition;
}

interface ProbeResult {
  readonly platform: NodeJS.Platform;
  readonly asr: { downloaded: boolean; bytes: number };
  readonly pack: { installed: boolean; bytes: number; error?: string };
}

const execFileAsync = promisify(execFile);

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeFixture(path: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function probe(configPath: string): Promise<ProbeResult> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as ProbeConfig;
  const [asr, pack] = await Promise.all([
    inspectAsrModel(config.asr, config.cacheDir),
    __inspectModelPackForVerify(config.pack, config.cacheDir),
  ]);
  return { platform: process.platform, asr, pack };
}

async function runFreshProcess(configPath: string): Promise<ProbeResult> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--import', 'tsx', fileURLToPath(import.meta.url), '--probe', configPath,
  ], { encoding: 'utf8' });
  assert.equal(stderr, '');
  return JSON.parse(stdout) as ProbeResult;
}

function fixtureConfig(cacheDir: string): {
  config: ProbeConfig;
  files: readonly [string, Buffer][];
} {
  const onnx = Buffer.from('synthetic-onnx-model');
  const ggml = Buffer.from('synthetic-ggml-model');
  const semantic = Buffer.from('synthetic-semantic-model');
  const asr: AsrModelEntry = {
    id: 'tiny',
    modelId: 'fixture/whisper-tiny',
    revision: 'a'.repeat(40),
    files: [{ path: 'onnx/model.onnx', sizeBytes: onnx.length, sha256: sha256(onnx) }],
    ggmlFile: {
      fileName: 'ggml-tiny.bin',
      sizeBytes: ggml.length,
      sha256: sha256(ggml),
      revision: 'b'.repeat(40),
    },
    label: 'Fixture Whisper Tiny',
    sizeLabel: 'fixture',
    language: 'fixture',
    note: 'fixture',
  };
  const pack: ModelPackDefinition = {
    id: 'music-semantics-lite',
    label: 'Fixture semantic pack',
    description: 'fixture',
    modelId: 'fixture/semantic-lite',
    revision: 'c'.repeat(40),
    license: 'Apache-2.0',
    sizeBytes: semantic.length,
    recommendedMemoryBytes: 1,
    capabilities: ['音乐语义向量'],
    files: [{ path: 'onnx/model.onnx', sizeBytes: semantic.length, sha256: sha256(semantic) }],
  };
  return {
    config: { cacheDir, asr, pack },
    files: [
      [join(cacheDir, asr.modelId, asr.files[0]!.path), onnx],
      [join(cacheDir, 'ggml', asr.ggmlFile.fileName), ggml],
      [join(cacheDir, pack.modelId, pack.files[0]!.path), semantic],
    ],
  };
}

async function verifyRestartPersistence(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'openchatcut-model-restart-'));
  const { config, files } = fixtureConfig(modelCachePath(home));
  const configPath = join(home, 'probe.json');

  try {
    await Promise.all(files.map(([path, content]) => writeFixture(path, content)));
    await writeFile(configPath, JSON.stringify(config));

    const beforeRestart = await runFreshProcess(configPath);
    const afterRestart = await runFreshProcess(configPath);
    assert.deepEqual(afterRestart, beforeRestart, 'fresh processes must rediscover the same model files');
    assert.equal(afterRestart.asr.downloaded, true);
    assert.equal(afterRestart.pack.installed, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--probe') {
  process.stdout.write(JSON.stringify(await probe(process.argv[3]!)));
} else {
  await verifyRestartPersistence();
  console.log(`model-persistence-restart.verify: ${process.platform} fresh-process restart OK`);
}
