// Real HTTP consumers use SQLite immediately after automatic startup.
// Legacy files remain immutable backups; retired migration controls return 404.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-migrate-http-verify-'));
  const previousHome = process.env.HOME;
  const previousSwitch = process.env.OPENCHATCUT_SQLITE_STORE;
  delete process.env.OPENCHATCUT_SQLITE_STORE;
  process.env.HOME = root;

  let app: http.Server | undefined;
  try {
    // Runtime profile is cached at module load; import only after HOME isolation.
    const { projectStorePlugin } = await import('../plugins/project-store-plugin.ts');
    const { storageLifecyclePlugin } = await import('../plugins/storage-lifecycle.ts');
    const { runtimeProfile } = await import('../runtime-profile.ts');
    const { resetSqliteStoreForTests, sqliteStoreReady, storePath } = await import('./sqlite-store.ts');
    const { resetSearchForTests } = await import('./fulltext-search.ts');
    const profile = runtimeProfile();
    mkdirSync(profile.projectStore.directory, { recursive: true });
    const legacyPath = join(profile.projectStore.directory, 'chat%3Ahttp-1.json');
    const legacyBytes = JSON.stringify({ messages: [{ role: 'user', text: 'legacy chat' }] });
    writeFileSync(legacyPath, legacyBytes);

    // Minimal vite-server-shaped stub: the plugin only uses middlewares.use
    // and config.logger.error.
    const middlewares: Array<{ path: string; handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void }> = [];
    const stubServer = {
      middlewares: {
        use: (path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void) => {
          middlewares.push({ path, handler });
        },
      },
      config: { logger: { error: () => undefined } },
    };
    await storageLifecyclePlugin().configureServer(stubServer as never);
    assert.equal(sqliteStoreReady(), true, 'startup imports automatically before accepting HTTP');
    projectStorePlugin({ http: true }).configureServer(stubServer as never);

    app = http.createServer((req, res) => {
      for (const { path, handler } of middlewares) {
        if (req.url?.startsWith(path)) {
          // Match Connect: keep the stripped URL for the entire async handler.
          req.url = req.url.slice(path.length) || '/';
          void Promise.resolve(handler(req, res)).catch((error: unknown) => {
            res.writeHead(500).end(String(error));
          });
          return;
        }
      }
      res.writeHead(404).end();
    });
    const listeningApp = app;
    await new Promise<void>((resolve) => listeningApp.listen(0, '127.0.0.1', resolve));
    const port = (app.address() as AddressInfo).port;

    const request = (path: string, init: {
      method: string; headers?: Record<string, string>; body?: unknown;
    }) =>
      new Promise<{ status: number; json(): Promise<unknown> }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: `${'/api/project-store'}${path}`,
          method: init.method,
          headers: {
            host: `localhost:${port}`,
            origin: `http://localhost:${port}`,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            ...init.headers,
          },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(data),
          }));
        });
        req.on('error', reject);
        req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
      });

    const imported = await request('/entry?key=chat%3Ahttp-1', { method: 'GET' });
    assert.equal(imported.status, 200);
    assert.deepEqual(await imported.json(), { found: true, value: JSON.parse(legacyBytes) });
    const noOrigin = await request('/entry', {
      method: 'PUT', headers: { origin: '', 'sec-fetch-site': 'none' },
      body: { key: 'chat:http-1', value: { forbidden: true } },
    });
    assert.equal(noOrigin.status, 403, 'writes still require matching Origin');
    const crossSite = await request('/entry?key=chat%3Ahttp-1', {
      method: 'GET', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403, 'cross-site reads remain unauthorized');

    const sqliteValue = { messages: [{ role: 'user', text: 'SQLite persisted edit' }] };
    const saved = await request('/entry', {
      method: 'PUT', body: { key: 'chat:http-1', value: sqliteValue },
    });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyBytes,
      'consumer writes cannot modify original JSON backups');

    resetSearchForTests();
    resetSqliteStoreForTests();
    writeFileSync(legacyPath, '{outdated-backup');
    process.env.OPENCHATCUT_SQLITE_STORE = '0';
    await storageLifecyclePlugin().configureServer(stubServer as never);
    const reopened = await request('/entry?key=chat%3Ahttp-1', { method: 'GET' });
    assert.equal(reopened.status, 200);
    assert.deepEqual(await reopened.json(), { found: true, value: sqliteValue },
      'HTTP consumers retain SQLite authority across restart despite stale backups and env=0');
    resetSearchForTests();
    resetSqliteStoreForTests();
    rmSync(storePath(), { force: true });
    rmSync(`${storePath()}-wal`, { force: true });
    rmSync(`${storePath()}-shm`, { force: true });
    await assert.rejects(
      storageLifecyclePlugin().configureServer(stubServer as never),
      /unreadable legacy record/,
      'server startup must reject an incomplete import instead of falling back to JSON',
    );
    assert.equal(sqliteStoreReady(), false);
    const failedRead = await request('/entry?key=chat%3Ahttp-1', { method: 'GET' });
    assert.equal(failedRead.status, 400, 'failed storage cannot return an empty successful response');
    assert.equal(readFileSync(legacyPath, 'utf8'), '{outdated-backup');
    resetSqliteStoreForTests();

    console.log('SQLite startup HTTP: automatic import, authorization, persistence and fail-closed recovery passed');
  } finally {
    if (app) await new Promise<void>((resolve, reject) => app!.close((error) => error ? reject(error) : resolve()));
    if (previousSwitch === undefined) delete process.env.OPENCHATCUT_SQLITE_STORE;
    else process.env.OPENCHATCUT_SQLITE_STORE = previousSwitch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
