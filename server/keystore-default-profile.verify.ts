import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-keystore-default-'));
const checkout = join(fixture, 'checkout');
const envPath = join(checkout, '.env.local');
const previousCwd = process.cwd();
const previousProfile = process.env.OPENCHATCUT_DEV_PROFILE_ID;

try {
  await mkdir(checkout, { recursive: true });
  await writeFile(envPath, 'OPENAI_API_KEY=old\n', { mode: 0o644 });
  process.chdir(checkout);
  delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
  const { setKeys } = await import('./keystore.ts');
  await setKeys({ OPENAI_API_KEY: 'new-secret' });
  if (process.platform !== 'win32') assert.equal((await stat(envPath)).mode & 0o777, 0o600);
} finally {
  process.chdir(previousCwd);
  if (previousProfile === undefined) delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
  else process.env.OPENCHATCUT_DEV_PROFILE_ID = previousProfile;
  await rm(fixture, { recursive: true, force: true });
}
