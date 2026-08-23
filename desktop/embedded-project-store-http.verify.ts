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
    const response = await fetch(`${embedded.origin}/api/project-store/migrate-status`, {
      headers: {
        Origin: embedded.origin,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    const contentType = response.headers.get('content-type') ?? '';
    assert.equal(response.status, 200);
    assert.match(contentType, /application\/json/i, 'embedded project-store migration status must be JSON');
    const body = await response.json() as { phase?: string };
    assert.ok(body.phase, 'migration status body must include a phase');

    const migrate = await fetch(`${embedded.origin}/api/project-store/migrate`, {
      method: 'POST',
      headers: {
        Origin: embedded.origin,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    const migrateContentType = migrate.headers.get('content-type') ?? '';
    assert.equal(migrate.status, 200);
    assert.match(migrateContentType, /application\/json/i, 'embedded project-store migrate must be JSON');
    const migrateBody = await migrate.json() as { enabled?: boolean; status?: { phase?: string } };
    assert.equal(migrateBody.enabled, true, 'migration response must report enabled storage');
    assert.equal(migrateBody.status?.phase, 'complete', 'migration response must report complete phase');
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

console.log('embedded-project-store-http.verify: migration HTTP endpoint is mounted in desktop embedded server');
