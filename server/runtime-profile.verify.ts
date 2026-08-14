import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATA_DIR_ENV, DEV_PROFILE_ID_ENV, defaultRootDir, resolveRuntimeProfile } from './runtime-profile.ts';
import { dataDirPointerPath } from './data-dir.ts';
import { projectStoreAuthDir } from './project-store-http-auth.ts';

const homeDir = resolve('runtime-profile-fixtures', 'home');
const cwd = resolve('runtime-profile-fixtures', 'checkout');
const globalRoot = join(homeDir, '.openchatcut');
const defaultProfile = resolveRuntimeProfile({}, { homeDir, cwd });

assert.deepEqual(defaultProfile, {
  mode: 'default',
  id: 'default',
  rootDir: globalRoot,
  authDir: join(globalRoot, 'project-store-auth-v1'),
  mediaDir: join(cwd, 'public', 'media', 'uploads'),
  generationJobStore: join(globalRoot, 'generation-operations-v1.json'),
  keystorePath: resolve(cwd, '.env.local'),
  projectStore: {
    legacyStorePath: join(globalRoot, 'project-store-v1.json'),
    legacyBackupPath: join(globalRoot, 'project-store-v1.json.migrated'),
    directory: join(globalRoot, 'project-store-v1'),
    indexPath: join(globalRoot, 'project-store-v1', 'projects.json'),
    quarantineDir: join(globalRoot, 'project-store-v1', '.quarantine'),
    readyPath: join(globalRoot, 'project-store-v1', '.ready'),
    tombstonePath: join(globalRoot, 'deleted-projects-v1.json'),
  },
});

const customAuth = resolve('runtime-profile-fixtures', 'custom-auth');
const customGeneration = resolve('runtime-profile-fixtures', 'custom-generation.json');
const overriddenDefault = resolveRuntimeProfile({
  OPENCHATCUT_PROJECT_STORE_AUTH_DIR: ` ${customAuth} `,
  OPENCHATCUT_GENERATION_JOB_STORE: customGeneration,
}, { homeDir, cwd });
assert.equal(overriddenDefault.mode, 'default');
assert.equal(overriddenDefault.authDir, customAuth);
assert.equal(overriddenDefault.generationJobStore, customGeneration);
assert.equal(resolveRuntimeProfile({ OPENCHATCUT_GENERATION_JOB_STORE: '' }, {
  homeDir,
  cwd,
}).generationJobStore, '');

const profileAId = '11111111-1111-4111-8111-111111111111';
const profileBId = '22222222-2222-4222-8222-222222222222';
const isolatedA = resolveRuntimeProfile({
  [DEV_PROFILE_ID_ENV]: profileAId,
  OPENCHATCUT_PROJECT_STORE_AUTH_DIR: customAuth,
  OPENCHATCUT_GENERATION_JOB_STORE: customGeneration,
}, { homeDir, cwd });
const isolatedB = resolveRuntimeProfile({ [DEV_PROFILE_ID_ENV]: profileBId }, { homeDir, cwd });

assert.equal(isolatedA.mode, 'isolated-dev');
if (isolatedA.mode !== 'isolated-dev') throw new Error('expected isolated profile');
const isolatedRoot = join(globalRoot, 'dev-profiles', profileAId);
assert.equal(isolatedA.id, profileAId);
assert.equal(isolatedA.rootDir, isolatedRoot);
assert.equal(isolatedA.authDir, join(isolatedRoot, 'project-store-auth-v1'));
assert.equal(isolatedA.mediaDir, join(isolatedRoot, 'media', 'uploads'));
assert.equal(isolatedA.generationJobStore, join(isolatedRoot, 'generation-operations-v1.json'));
assert.equal(isolatedA.keystorePath, join(isolatedRoot, 'settings.env'));
assert.equal(isolatedA.projectStore.directory, join(isolatedRoot, 'project-store-v1'));
assert.equal(isolatedA.projectStore.indexPath, join(isolatedRoot, 'project-store-v1', 'projects.json'));
assert.equal(isolatedA.projectStore.tombstonePath, join(isolatedRoot, 'deleted-projects-v1.json'));
assert.notEqual(isolatedA.projectStore.directory, defaultProfile.projectStore.directory);
assert.notEqual(isolatedA.projectStore.directory, isolatedB.projectStore.directory);
assert.notEqual(isolatedA.authDir, isolatedB.authDir);
assert.notEqual(isolatedA.mediaDir, isolatedB.mediaDir);
assert.notEqual(isolatedA.keystorePath, isolatedB.keystorePath);
assert.notEqual(isolatedA.keystorePath, defaultProfile.keystorePath);

assert.equal(projectStoreAuthDir(isolatedA), isolatedA.authDir);
assert.equal(projectStoreAuthDir(isolatedB), isolatedB.authDir);
assert.notEqual(projectStoreAuthDir(isolatedA), projectStoreAuthDir(defaultProfile));
for (const value of [
  '',
  ' 11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111 ',
  '../11111111-1111-4111-8111-111111111111',
  '11111111-1111-1111-8111-111111111111',
  '11111111-1111-4111-7111-111111111111',
  'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
]) {
  assert.throws(
    () => resolveRuntimeProfile({ [DEV_PROFILE_ID_ENV]: value }, { homeDir, cwd }),
    /lowercase UUID v4/,
  );
}
assert.throws(
  () => resolveRuntimeProfile({ OPENCHATCUT_DEV_PROFILE_ROOT: isolatedRoot }, { homeDir, cwd }),
  /Unsupported isolated development profile variable/,
);

// ── User-chosen storage root ─────────────────────────────────────────────────
// The whole point of the setting is that projects survive removing the app, so the
// chosen root must win over every default: the hidden global root, the per-checkout
// media folder, and the isolated dev profile root.
const dataDirHome = mkdtempSync(join(tmpdir(), 'openchatcut-runtime-data-dir-'));
try {
  const chosen = join(dataDirHome, 'Saves', 'OpenChatCut');
  const envDataDir = resolveRuntimeProfile({ [DATA_DIR_ENV]: chosen }, { homeDir: dataDirHome, cwd });
  assert.equal(envDataDir.mode, 'default');
  assert.equal(envDataDir.rootDir, chosen);
  assert.equal(envDataDir.authDir, join(chosen, 'project-store-auth-v1'));
  assert.equal(envDataDir.generationJobStore, join(chosen, 'generation-operations-v1.json'));
  assert.equal(envDataDir.projectStore.directory, join(chosen, 'project-store-v1'));
  assert.equal(envDataDir.projectStore.tombstonePath, join(chosen, 'deleted-projects-v1.json'));
  // Media follows the projects it backs, instead of staying in the checkout.
  assert.equal(envDataDir.mediaDir, join(chosen, 'media', 'uploads'));
  // The keystore stays with the checkout in default mode: it is not project data.
  assert.equal(envDataDir.keystorePath, resolve(cwd, '.env.local'));

  // `~/` expands, whitespace is trimmed, and a blank value is the same as no value.
  assert.equal(
    resolveRuntimeProfile({ [DATA_DIR_ENV]: '  ~/Saves  ' }, { homeDir: dataDirHome, cwd }).rootDir,
    join(dataDirHome, 'Saves'),
  );
  assert.equal(
    resolveRuntimeProfile({ [DATA_DIR_ENV]: '~' }, { homeDir: dataDirHome, cwd }).rootDir,
    dataDirHome,
  );
  assert.equal(
    resolveRuntimeProfile({ [DATA_DIR_ENV]: '   ' }, { homeDir: dataDirHome, cwd }).rootDir,
    join(dataDirHome, '.openchatcut'),
  );
  // A typo must fail loudly: silently falling back would hide the projects somewhere
  // the user never chose, which is exactly what this setting exists to prevent.
  assert.throws(
    () => resolveRuntimeProfile({ [DATA_DIR_ENV]: 'relative/saves' }, { homeDir: dataDirHome, cwd }),
    /must be an absolute path/,
  );

  // With no environment variable, the pointer file recorded by the settings UI is used,
  // and the environment variable wins over it when both are present.
  const pointed = join(dataDirHome, 'Pointed');
  mkdirSync(join(dataDirHome, '.openchatcut'), { recursive: true });
  writeFileSync(dataDirPointerPath(dataDirHome), JSON.stringify({ version: 1, dataDir: pointed }));
  assert.equal(resolveRuntimeProfile({}, { homeDir: dataDirHome, cwd }).rootDir, pointed);
  assert.equal(
    resolveRuntimeProfile({ [DATA_DIR_ENV]: chosen }, { homeDir: dataDirHome, cwd }).rootDir,
    chosen,
  );
  // A damaged pointer degrades to the default root rather than blocking startup.
  writeFileSync(dataDirPointerPath(dataDirHome), 'not json at all');
  assert.equal(
    resolveRuntimeProfile({}, { homeDir: dataDirHome, cwd }).rootDir,
    join(dataDirHome, '.openchatcut'),
  );

  // An isolated dev profile keeps its own keystore, but its data moves too: the user
  // asked for a visible, durable location, which outranks the per-checkout root.
  const isolatedData = resolveRuntimeProfile({
    [DEV_PROFILE_ID_ENV]: profileAId,
    [DATA_DIR_ENV]: chosen,
  }, { homeDir: dataDirHome, cwd });
  assert.equal(isolatedData.mode, 'isolated-dev');
  assert.equal(isolatedData.rootDir, chosen);
  assert.equal(isolatedData.mediaDir, join(chosen, 'media', 'uploads'));
  assert.equal(isolatedData.keystorePath, join(chosen, 'settings.env'));

  // defaultRootDir answers "where does clearing the field lead?", so it must ignore
  // the configured root in both modes.
  assert.equal(defaultRootDir(envDataDir, dataDirHome), join(dataDirHome, '.openchatcut'));
  assert.equal(
    defaultRootDir(isolatedData, dataDirHome),
    join(dataDirHome, '.openchatcut', 'dev-profiles', profileAId),
  );
} finally {
  rmSync(dataDirHome, { recursive: true, force: true });
}
