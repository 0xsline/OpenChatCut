import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedCopilotCredentialStore, type CopilotEncryption } from './oauth-store.ts';
import { parseStoredCopilotAuth, type CopilotStoredAuth } from './oauth-types.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-copilot-vault-'));
const key = randomBytes(32);
let available = true;
const encryption: CopilotEncryption = {
  isEncryptionAvailable: () => available,
  encryptString(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(value) {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  },
};
const path = join(root, 'profile', 'copilot-auth-v1.enc');
const stored: CopilotStoredAuth = {
  version: 1, kind: 'oauth', clientId: 'Ov23liTestClientId', login: 'test-user',
  accessToken: 'private-access-token', refreshToken: 'private-refresh-token', expiresAt: 1_000_000,
};
try {
  const vault = new EncryptedCopilotCredentialStore(path, encryption);
  assert.equal(await vault.read(), null);
  await vault.write(stored);
  const disk = await readFile(path);
  assert.equal(disk.includes(Buffer.from('private-access-token')), false);
  assert.equal(disk.includes(Buffer.from('private-refresh-token')), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await new EncryptedCopilotCredentialStore(path, encryption).read(), stored,
    'an app restart restores encrypted credentials');
  available = false;
  assert.equal(vault.available(), false);
  await assert.rejects(vault.write(stored), /Secure system credential storage is unavailable/);
  await assert.rejects(vault.read(), /Secure system credential storage is unavailable/);
  assert.deepEqual(await readFile(path), disk, 'unavailable encryption never overwrites with plaintext');
  available = true;
  await writeFile(path, '{"accessToken":"plaintext-must-not-load"}');
  await assert.rejects(vault.read(), /Could not unlock/);
  await vault.write({ version: 1, kind: 'signed-out' });
  assert.deepEqual(await vault.read(), { version: 1, kind: 'signed-out' },
    'sign-out can recover from corrupt credentials without retaining the old secret');
  await vault.write(null);
  assert.equal(await vault.read(), null);
  for (const value of [{}, { ...stored, accessToken: '' }, { ...stored, expiresAt: NaN },
    { ...stored, refreshExpiresAt: -1 }, { ...stored, login: '<script>' }]) {
    assert.throws(() => parseStoredCopilotAuth(value), /Stored Copilot sign-in is invalid/);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('copilot-oauth-store.verify: encrypted-only persistence, restart, permissions, unavailable storage and corruption passed');
