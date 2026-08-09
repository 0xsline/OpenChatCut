import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EDITOR_CREDENTIAL_HEADER,
  editorBootstrapPayload,
  externalMcpToken,
} from '../editor-auth';
import {
  PROJECT_STORE_LAUNCH_TOKEN_HEADER,
  projectStoreLaunchToken,
} from '../project-store-http-auth';
import { handleModelPackRequest, modelPackMutationRequestError } from './model-packs';
import { recoverDirectorySwap, replaceDirectoryAtomically } from './model-pack-install';

assert.equal(modelPackMutationRequestError({ 'content-type': 'application/json' }), null);
assert.deepEqual(modelPackMutationRequestError({ 'content-type': 'text/plain' }), {
  status: 415,
  error: 'content-type must be application/json',
});
assert.deepEqual(modelPackMutationRequestError({
  'content-type': 'application/json',
  origin: 'https://evil.example',
  host: '127.0.0.1:5199',
  'sec-fetch-site': 'cross-site',
}), {
  status: 403,
  error: 'cross-site requests are not allowed',
});

const server = createServer((req, res) => {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  void handleModelPackRequest(req, res, pathname).catch((error) => {
    res.statusCode = 500;
    res.end(error instanceof Error ? error.message : String(error));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const packId = 'rhythm-lite';
const mutationPaths = [
  '/api/model-packs/download',
  '/api/model-packs/cancel',
  '/api/model-packs/delete',
] as const;

async function postMutation(path: string, headers?: HeadersInit): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Content-Type', 'application/json');
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ id: packId }),
  });
}

try {
  for (const path of mutationPaths) {
    assert.equal((await postMutation(path)).status, 401, `${path} must reject a request without credentials`);
    assert.equal((await postMutation(path, { Origin: origin })).status, 401,
      `${path} must not treat a same-origin header as authorization`);
    assert.equal((await postMutation(path, {
      Origin: origin,
      Authorization: `Bearer ${externalMcpToken()}`,
    })).status, 401, `${path} must not accept the MCP bearer as an editor credential`);
    assert.equal((await postMutation(path, {
      Origin: origin,
      [PROJECT_STORE_LAUNCH_TOKEN_HEADER]: projectStoreLaunchToken(),
    })).status, 401, `${path} must not accept a project-store launch credential`);
  }
  assert.equal((await fetch(`${origin}/api/model-packs/download`, {
    method: 'POST',
    body: '{not-json',
  })).status, 401, 'authorization must run before content-type and body parsing');
  assert.equal((await postMutation('/api/model-packs/cancel', {
    Origin: origin,
    [EDITOR_CREDENTIAL_HEADER]: editorBootstrapPayload().credential,
  })).status, 200, 'same-origin editor credentials must authorize model-pack mutations');
} finally {
  server.close();
  await once(server, 'close');
}

const root = await mkdtemp(join(tmpdir(), 'openchatcut-model-pack-'));
try {
  const installed = join(root, 'installed');
  const staged = join(root, 'staged');
  const backup = join(root, 'backup');
  await mkdir(installed);
  await mkdir(staged);
  await writeFile(join(installed, 'model.bin'), 'old');
  await writeFile(join(staged, 'model.bin'), 'new');
  await replaceDirectoryAtomically(staged, installed, backup);
  assert.equal(await readFile(join(installed, 'model.bin'), 'utf8'), 'new');
  await assert.rejects(readFile(join(backup, 'model.bin')), { code: 'ENOENT' });

  await mkdir(backup);
  await writeFile(join(backup, 'model.bin'), 'stale-old');
  await recoverDirectorySwap(installed, backup);
  assert.equal(await readFile(join(installed, 'model.bin'), 'utf8'), 'new');
  await assert.rejects(readFile(join(backup, 'model.bin')), { code: 'ENOENT' });

  const missingStage = join(root, 'missing-stage');
  await assert.rejects(replaceDirectoryAtomically(missingStage, installed, backup));
  assert.equal(
    await readFile(join(installed, 'model.bin'), 'utf8'),
    'new',
    'a failed staged-directory rename restores the installed pack',
  );

  await rm(installed, { recursive: true });
  await mkdir(backup);
  await writeFile(join(backup, 'model.bin'), 'recover-me');
  await recoverDirectorySwap(installed, backup);
  assert.equal(await readFile(join(installed, 'model.bin'), 'utf8'), 'recover-me');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('model-pack-install.verify: ok');
