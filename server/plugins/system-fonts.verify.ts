import assert from 'node:assert/strict';
import { createServer, type ViteDevServer } from 'vite';
import { systemFontsPlugin } from './system-fonts.ts';

const plugin = systemFontsPlugin();
assert.equal(plugin.name, 'openchatcut-system-fonts');

let server: ViteDevServer | undefined;
try {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [systemFontsPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object');

  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/system-fonts`);
  assert.equal(response.status, 200);

  const data = await response.json() as {
    ok: boolean;
    userFonts: string[];
    systemFonts: string[];
    allFonts: string[];
    timestamp: number;
  };

  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.userFonts));
  assert.ok(Array.isArray(data.systemFonts));
  assert.ok(Array.isArray(data.allFonts));
  assert.ok(typeof data.timestamp === 'number');

  // POST or refresh=1 test
  const refreshResponse = await fetch(`${origin}/api/system-fonts?refresh=1`);
  assert.equal(refreshResponse.status, 200);
  const refreshData = await refreshResponse.json() as { ok: boolean; allFonts: string[] };
  assert.equal(refreshData.ok, true);
  assert.ok(Array.isArray(refreshData.allFonts));
} finally {
  await server?.close();
}

console.log('system-fonts plugin verification passed');
