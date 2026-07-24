// Shared extended storage API: installation, version isolation, start and stop, and uninstall. npx tsx server/plugins/extension-store.verify.ts
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionStorePlugin } from './extension-store';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function createHarness(rootDir: string) {
  let route = '';
  let middleware: Middleware | null = null;
  const plugin = extensionStorePlugin({ rootDir });
  assert.equal(typeof plugin.configureServer, 'function');
  (plugin.configureServer as (server: unknown) => void)({
    middlewares: {
      use(path: string, handler: Middleware) { route = path; middleware = handler; },
    },
    config: { logger: { error() {} } },
  });
  assert.equal(route, '/api/plugins');
  assert.ok(middleware);
  const server = createServer((req, res) => {
    if (!req.url?.startsWith(route)) { res.statusCode = 404; res.end(); return; }
    req.url = req.url.slice(route.length) || '/';
    middleware?.(req, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    base: `http://127.0.0.1:${address.port}${route}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const rootDir = await mkdtemp(join(tmpdir(), 'openchatcut-extensions-'));
const harness = await createHarness(rootDir);
const pack = {
  format: 'openchatcut-plugin@1',
  id: 'demo-pack',
  name: 'Demo Pack',
  version: '..',
  items: [{ type: 'zoom', id: 'pulse', name: 'Pulse', envelope: [0, 1] }],
  installedAt: Date.now(),
  enabled: true,
};

try {
  let response = await fetch(`${harness.base}/${pack.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pack),
  });
  assert.equal(response.status, 200);
  const versionDir = Buffer.from(pack.version).toString('base64url');
  assert.ok(await exists(join(rootDir, pack.id, versionDir, 'manifest.json')), 'The version directory must remain in the extension id down');
  assert.equal(await exists(join(rootDir, 'manifest.json')), false, 'The version name is not directory traversable');

  response = await fetch(harness.base);
  let body = await response.json() as { packs: Array<{ id: string; enabled: boolean }> };
  assert.equal(body.packs[0]?.id, pack.id);
  assert.equal(body.packs[0]?.enabled, true);

  response = await fetch(`${harness.base}/${pack.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(response.status, 200);
  body = await (await fetch(harness.base)).json() as typeof body;
  assert.equal(body.packs[0]?.enabled, false);

  response = await fetch(`${harness.base}/${pack.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(await exists(join(rootDir, pack.id)), false);
  assert.deepEqual(JSON.parse(await readFile(join(rootDir, 'index.json'), 'utf8')), []);
  console.log('extension-store: Installation/version isolation/Start and stop/Uninstall OK');
} finally {
  await harness.close();
  await rm(rootDir, { recursive: true, force: true });
}
