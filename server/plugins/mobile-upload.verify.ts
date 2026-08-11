import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { MobileUploadSessionSnapshot } from '../mobile-upload-service';
import { handleMobileUploadControl } from './mobile-upload';

const snapshot: MobileUploadSessionSnapshot = {
  id: 'a',
  urls: ['http://192.0.2.1:1234/s/opaque-token'],
  expiresAt: Date.now() + 60_000,
  files: [],
};
let creates = 0;
let reads = 0;
let deletes = 0;
const controls = {
  async createSession(locale: 'zh' | 'en' = 'zh') {
    creates += 1;
    assert.equal(locale, 'en');
    return snapshot;
  },
  getSession(id: string) {
    reads += 1;
    assert.equal(id, snapshot.id);
    return snapshot;
  },
  async closeSession(id: string) {
    deletes += 1;
    assert.equal(id, snapshot.id);
    return snapshot;
  },
};
const server = createServer((req, res) => {
  void handleMobileUploadControl(req, res, controls);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;

try {
  const created = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST',
    headers: { origin },
  });
  assert.equal(created.status, 201);
  assert.equal(creates, 1, 'same-origin editor requests can create a session');

  const missingOrigin = await fetch(`${origin}/sessions?locale=en`, { method: 'POST' });
  assert.equal(missingOrigin.status, 401);
  assert.equal(creates, 1, 'mutations without Origin cannot create a session');

  const crossSite = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 401);
  assert.equal(creates, 1, 'a cross-site simple POST cannot create a session');

  const reboundCreate = await fetch(`${origin}/sessions?locale=en`, {
    method: 'POST',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  });
  assert.equal(reboundCreate.status, 401);
  assert.equal(creates, 1, 'matching attacker Host and Origin cannot create a session');

  const read = await fetch(`${origin}/sessions/${snapshot.id}`);
  assert.equal(read.status, 200);
  assert.equal(reads, 1, 'canonical trusted editor reads may omit Origin');

  const crossSiteRead = await fetch(`${origin}/sessions/${snapshot.id}`, {
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSiteRead.status, 403);
  assert.equal(reads, 1, 'cross-site pages cannot read a session');

  const reboundRead = await fetch(`${origin}/sessions/${snapshot.id}`, {
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  });
  assert.equal(reboundRead.status, 403);
  assert.equal(reads, 1, 'matching attacker Host and Origin cannot read a session');

  const deleted = await fetch(`${origin}/sessions/${snapshot.id}`, {
    method: 'DELETE',
    headers: { origin },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deletes, 1, 'same-origin editor requests can delete a session');

  const missingDeleteOrigin = await fetch(`${origin}/sessions/${snapshot.id}`, { method: 'DELETE' });
  assert.equal(missingDeleteOrigin.status, 401);
  assert.equal(deletes, 1, 'mutations without Origin cannot delete a session');

  const reboundDelete = await fetch(`${origin}/sessions/${snapshot.id}`, {
    method: 'DELETE',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  });
  assert.equal(reboundDelete.status, 401);
  assert.equal(deletes, 1, 'matching attacker Host and Origin cannot delete a session');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log('mobile-upload.verify: ok');
