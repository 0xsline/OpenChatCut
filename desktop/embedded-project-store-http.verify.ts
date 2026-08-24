import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'occ-embedded-project-store-'));
const previousHome = process.env.HOME;
const previousAppData = process.env.APPDATA;
const previousLocalAppData = process.env.LOCALAPPDATA;
process.env.HOME = root;
process.env.APPDATA = root;
process.env.LOCALAPPDATA = root;

try {
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(root, '.env.local'), '');
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>OpenChatCut</title>', { flush: true });
} catch {
  rmSync(root, { recursive: true, force: true });
  throw new Error('failed to prepare embedded server fixture');
}

try {
  const { startEmbeddedServer } = await import('./embedded-server.ts');
  const embedded = await startEmbeddedServer(join(root, 'dist'));
  try {
    const editorHeaders = {
      Origin: embedded.origin,
      'Sec-Fetch-Site': 'same-origin',
    };
    const response = await fetch(`${embedded.origin}/api/project-store/migrate-status`, {
      headers: editorHeaders,
    });
    const contentType = response.headers.get('content-type') ?? '';
    assert.equal(response.status, 200);
    assert.match(contentType, /application\/json/i, 'embedded project-store migration status must be JSON');
    const body = await response.json() as { phase?: string };
    assert.ok(body.phase, 'migration status body must include a phase');

    const migrate = await fetch(`${embedded.origin}/api/project-store/migrate`, {
      method: 'POST',
      headers: editorHeaders,
    });
    const migrateContentType = migrate.headers.get('content-type') ?? '';
    assert.equal(migrate.status, 200);
    assert.match(migrateContentType, /application\/json/i, 'embedded project-store migrate must be JSON');
    const migrateBody = await migrate.json() as { enabled?: boolean; status?: { phase?: string } };
    assert.equal(migrateBody.enabled, true, 'migration response must report enabled storage');
    assert.equal(migrateBody.status?.phase, 'complete', 'migration response must report complete phase');

    const unauthorizedWrite = await fetch(`${embedded.origin}/api/project-store/entry`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ key: 'embedded-http-smoke', value: { ready: true } }),
    });
    assert.equal(unauthorizedWrite.status, 403, 'embedded project-store writes must require same-origin requests');

    const write = await fetch(`${embedded.origin}/api/project-store/entry`, {
      method: 'PUT',
      headers: { ...editorHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'embedded-http-smoke', value: { ready: true } }),
    });
    assert.equal(write.status, 200, 'embedded project-store must accept same-origin writes');
    const read = await fetch(`${embedded.origin}/api/project-store/entry?key=embedded-http-smoke`, {
      headers: editorHeaders,
    });
    assert.equal(read.status, 200, 'embedded project-store must expose persisted entries');
    const readBody = await read.json() as { found?: boolean; value?: { ready?: boolean } };
    assert.deepEqual(readBody, { found: true, value: { ready: true } });
  } finally {
    await new Promise<void>((resolve) => embedded.server.close(() => resolve()));
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  rmSync(root, { recursive: true, force: true });
}

console.log('embedded-project-store-http.verify: migration, auth, write, and read paths are mounted in desktop');
