import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEV_PROFILE_ID_ENV, resolveRuntimeProfile } from './runtime-profile.ts';
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
