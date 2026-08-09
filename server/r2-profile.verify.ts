import assert from 'node:assert/strict';

const profileEnv = 'OPENCHATCUT_DEV_PROFILE_ID';
process.env[profileEnv] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Intentional module-boundary test: the profile env must exist before server modules initialize.

try {
  const {
    deleteUploadObject,
    getUploadObject,
    getUploadObjectToFile,
    presignGetUpload,
    presignPutUpload,
    putUploadObject,
    r2Config,
    r2PresignEnabled,
  } = await import('./r2.ts');
  const { computeCaps, seedKeystore } = await import('./keystore.ts');
  const values = {
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'access-key',
    R2_SECRET_ACCESS_KEY: 'secret-key',
    R2_BUCKET: 'shared-bucket',
  };
  const get = (name: string) => values[name as keyof typeof values] ?? '';

  assert.equal(r2Config(get), null);
  assert.equal(r2Config(get, { ignoreEnabled: true }), null);
  assert.equal(r2PresignEnabled(get), false);
  assert.equal(await putUploadObject(
    'isolated.bin',
    Buffer.from('isolated'),
    'application/octet-stream',
    8,
    { rollbackToken: 'isolated-profile' },
  ), 'off');
  assert.equal(await deleteUploadObject('isolated.bin'), false);
  assert.equal(await getUploadObject('isolated.bin'), null);
  assert.equal(await presignPutUpload('isolated.bin'), null);
  assert.equal(await presignGetUpload('isolated.bin'), null);

  let sends = 0;
  const injected = {
    config: {
      accountId: 'account',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      bucket: 'shared-bucket',
    },
    client: {
      send: async () => {
        sends += 1;
        throw new Error('isolated R2 client must not be called');
      },
    },
  } as unknown as NonNullable<Parameters<typeof getUploadObjectToFile>[2]>;
  assert.equal(await getUploadObjectToFile('isolated.bin', '/unused/isolated.bin', injected), null);
  assert.equal(sends, 0);

  seedKeystore(values);
  assert.equal(computeCaps().storage, false);
} finally {
  delete process.env[profileEnv];
}
