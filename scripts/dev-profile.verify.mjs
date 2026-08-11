import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEV_PROFILE_METADATA,
  loadOrCreateDevProfile,
  profileChildEnvironment,
} from './dev-profile.mjs';

const UUID_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-dev-profile-'));

async function fixturePaths(name) {
  const root = join(fixture, name);
  const gitDir = join(root, 'git-dir');
  const repoRoot = join(root, 'checkout');
  const homeDir = join(root, 'home');
  await Promise.all([
    mkdir(gitDir, { recursive: true }),
    mkdir(repoRoot, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
  ]);
  return { gitDir, repoRoot, homeDir };
}

async function expectInvalid(paths, value, pattern) {
  const metadataPath = join(paths.gitDir, DEV_PROFILE_METADATA);
  await writeFile(metadataPath, value, { mode: 0o600 });
  await assert.rejects(
    loadOrCreateDevProfile({ ...paths, randomId: () => UUID_A }),
    pattern,
  );
}

try {
  const stablePaths = await fixturePaths('stable');
  const first = await loadOrCreateDevProfile({ ...stablePaths, randomId: () => UUID_A });
  const reused = await loadOrCreateDevProfile({ ...stablePaths, randomId: () => UUID_B });
  assert.equal(first.id, UUID_A);
  assert.deepEqual(reused, first);
  assert.equal(first.rootDir, join(stablePaths.homeDir, '.openchatcut', 'dev-profiles', UUID_A));
  assert.deepEqual(
    JSON.parse(await readFile(join(stablePaths.gitDir, DEV_PROFILE_METADATA), 'utf8')),
    { version: 1, profileId: UUID_A, repoRoot: stablePaths.repoRoot },
  );
  await writeFile(
    first.keystorePath,
    "OPENAI_API_KEY='profile#secret'\nLLM_BASE_URL=https://example.test/\\$route\nASSEMBLYAI_API_KEY=\n",
    { mode: 0o600 },
  );
  const childEnvironment = await profileChildEnvironment(first, {
    OPENAI_API_KEY: 'checkout-secret',
    UNRELATED: 'inherited',
    OPENCHATCUT_DEV_PROFILE_ID: UUID_B,
    ASSEMBLYAI_API_KEY: 'checkout-transcription-secret',
  });
  assert.equal(childEnvironment.OPENAI_API_KEY, 'profile#secret');
  assert.equal(childEnvironment.LLM_BASE_URL, 'https://example.test/$route');
  assert.equal(childEnvironment.UNRELATED, 'inherited');
  assert.equal(childEnvironment.ASSEMBLYAI_API_KEY, '',
    'an isolated empty-value tombstone must suppress an inherited checkout secret');
  assert.equal(childEnvironment.OPENCHATCUT_DEV_PROFILE_ID, UUID_A);
  if (process.platform !== 'win32') {
    assert.equal((await stat(first.metadataPath)).mode & 0o777, 0o600);
    assert.equal((await stat(first.rootDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.rootDir, 'electron-user-data'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.rootDir, 'project-store-auth-v1'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(first.rootDir, 'media', 'uploads'))).mode & 0o777, 0o700);
  }

  const concurrentPaths = await fixturePaths('concurrent');
  const [left, right] = await Promise.all([
    loadOrCreateDevProfile({ ...concurrentPaths, randomId: () => UUID_A }),
    loadOrCreateDevProfile({ ...concurrentPaths, randomId: () => UUID_B }),
  ]);
  assert.equal(left.id, right.id);
  assert.ok(left.id === UUID_A || left.id === UUID_B);

  await expectInvalid(await fixturePaths('corrupt'), '{not-json', /not valid JSON/);
  await expectInvalid(
    await fixturePaths('partial'),
    JSON.stringify({ version: 1, profileId: UUID_A }),
    /expected only version, profileId, and repoRoot/,
  );
  await expectInvalid(
    await fixturePaths('traversal'),
    JSON.stringify({ version: 1, profileId: '../escape', repoRoot: join(fixture, 'traversal', 'checkout') }),
    /invalid profileId/,
  );

  const movedPaths = await fixturePaths('moved');
  await loadOrCreateDevProfile({ ...movedPaths, randomId: () => UUID_A });
  await assert.rejects(
    loadOrCreateDevProfile({
      ...movedPaths,
      repoRoot: join(fixture, 'other-checkout'),
      randomId: () => UUID_B,
    }),
    /repoRoot changed.*Remove that file to regenerate/s,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
