// HTTP-layer verification for the storage migration endpoints.
//
// Boots a REAL node:http server with the project-store plugin middleware and
// exercises the full credential flow: launch-token exchange → session →
// migrate → migrate-status, plus the 403 rejections. Isolated via temporary
// HOME and a throwaway launch token.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-migrate-http-verify-'));
  const previousHome = process.env.HOME;
  const previousLaunch = process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN;
  process.env.HOME = root;
  process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN = 'http-verify-launch-token-'.padEnd(48, 'x');

  const serverHandle: { close: () => void } = { close: () => undefined };
  try {
    const { projectStorePlugin } = await import('../plugins/project-store-plugin.ts');

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
    projectStorePlugin({ http: true }).configureServer(stubServer as never);

    const app = http.createServer((req, res) => {
      for (const { path, handler } of middlewares) {
        if (req.url?.startsWith(path)) {
          // connect semantics: the mount prefix is stripped before the handler
          // runs (the plugin compares req.url against '/session' etc.).
          const original = req.url;
          req.url = original.slice(path.length) || '/';
          void handler(req, res);
          req.url = original;
          return;
        }
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app.address() as AddressInfo).port;
    serverHandle.close = () => app.close();

    // node:http.request (fetch forbids the Origin header, which sameOrigin
    // checks require for the launch-token exchange).
    const request = (path: string, init: { method: string; headers?: Record<string, string> }) =>
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
        req.end();
      });

    // 1. Read-only status without any credential (loopback same-origin) → 200.
    const status0 = await request('/migrate-status', { method: 'GET' });
    assert.equal(status0.status, 200, 'loopback same-origin reads must be allowed');
    const body0 = await status0.json() as { enabled: boolean; receipt: unknown; jsonKeyCount: number };
    assert.equal(body0.enabled, false);
    assert.equal(body0.jsonKeyCount, 0);

    // 2. Write without session → 403.
    const noSession = await request('/migrate', { method: 'POST' });
    assert.equal(noSession.status, 403, 'migrate must require a real session');

    // 3. Launch-token exchange (wrong token) → 403.
    const badExchange = await request('/session', {
      method: 'POST',
      headers: { 'x-openchatcut-editor-launch-token': 'wrong-token-'.padEnd(48, 'w') },
    });
    assert.equal(badExchange.status, 403, 'a wrong launch token must be rejected');

    // 4. Seed legacy JSON data in file mode, then exchange with the real token.
    const store = await import('../plugins/project-store.ts');
    await store.setStoredEntry('chat:http-1', { m: 'one' });
    await store.setStoredEntry('project:http-p', { doc: { v: 1 }, updatedAt: 1 });
    await store.setStoredEntry('thumb:http-1', { t: true });

    const exchange = await request('/session', {
      method: 'POST',
      headers: { 'x-openchatcut-editor-launch-token': process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN },
    });
    assert.equal(exchange.status, 200, 'the real launch token must exchange for a session');
    const { sessionToken } = await exchange.json() as { sessionToken: string };
    assert.ok(sessionToken.length >= 32);

    const sessionHeaders = { 'x-openchatcut-project-store-session': sessionToken };

    // 5. Migrate over HTTP → 200, all three keys imported.
    const migrate = await request('/migrate', { method: 'POST', headers: sessionHeaders });
    assert.equal(migrate.status, 200);
    const migrateBody = await migrate.json() as { summary: { imported: number }; enabled: boolean };
    assert.equal(migrateBody.summary.imported, 3);
    assert.equal(migrateBody.enabled, true);

    // 6. Status now reports enabled + receipt + SQLite rows.
    const status1 = await request('/migrate-status', { method: 'GET', headers: sessionHeaders });
    const body1 = await status1.json() as { enabled: boolean; receipt: { count: number } | null; sqliteKeyCount: number };
    assert.equal(body1.enabled, true);
    assert.equal(body1.receipt?.count, 3);
    assert.equal(body1.sqliteKeyCount, 3);

    // 7. SQLite backend is live: a write goes to SQLite, not the JSON dir.
    const setEntry = await request('/migrate', { method: 'POST', headers: sessionHeaders }); // idempotent
    assert.equal(setEntry.status, 200);
    await sleep(30);

    console.log('✓ migrate-http verify: read-status / 403 write / token exchange / migrate / status-after / idempotent all passed');
  } finally {
    serverHandle.close();
    if (previousLaunch === undefined) delete process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN;
    else process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN = previousLaunch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
