import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profileId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-keystore-profile-'));
const checkout = join(fixture, 'checkout');
const home = join(fixture, 'home');
const profileRoot = join(home, '.openchatcut', 'dev-profiles', profileId);
const checkoutEnv = join(checkout, '.env.local');
const profileEnv = join(profileRoot, 'settings.env');
const previousCwd = process.cwd();
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousProfile = process.env.OPENCHATCUT_DEV_PROFILE_ID;

try {
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(profileRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(checkoutEnv, 'OPENAI_API_KEY=checkout-secret\n', 'utf8');
  process.chdir(checkout);
  // os.homedir() resolves USERPROFILE on Windows; HOME alone only covers POSIX.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCHATCUT_DEV_PROFILE_ID = profileId;
  // Intentional module-boundary test: cwd, HOME, and profile ID must be set before initialization.
  const { setKeys } = await import('./keystore.ts');
  await setKeys({ OPENAI_API_KEY: 'isolated-secret', LLM_MODEL: 'isolated-model' });

  assert.equal(await readFile(checkoutEnv, 'utf8'), 'OPENAI_API_KEY=checkout-secret\n');
  assert.match(await readFile(profileEnv, 'utf8'), /OPENAI_API_KEY=isolated-secret/);
  assert.match(await readFile(profileEnv, 'utf8'), /LLM_MODEL=isolated-model/);
  await setKeys({ OPENAI_API_KEY: '' });
  assert.match(await readFile(profileEnv, 'utf8'), /^OPENAI_API_KEY=$/m);
  if (process.platform !== 'win32') assert.equal((await stat(profileEnv)).mode & 0o777, 0o600);
} finally {
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousProfile === undefined) delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
  else process.env.OPENCHATCUT_DEV_PROFILE_ID = previousProfile;
  await rm(fixture, { recursive: true, force: true });
}
