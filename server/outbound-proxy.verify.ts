// Unified outbound proxy verify: keystore-first resolution, env fallback,
// dispatcher/agent caching on URL change, curl args, no-proxy no-op.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-proxy-verify-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const previousEnv: Record<string, string | undefined> = {};
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    previousEnv[name] = process.env[name];
    delete process.env[name];
  }

  try {
    const { outboundProxyUrl, proxyDispatcher, outboundHttpAgent, proxyCurlArgs } =
      await import('./outbound-proxy.ts');

    // ── no proxy configured → no-op ──
    assert.equal(outboundProxyUrl(), '', 'no env/keystore → empty URL');
    assert.equal(proxyDispatcher(), undefined, 'no dispatcher without a proxy');
    assert.equal(outboundHttpAgent(), undefined, 'no http agent without a proxy');
    assert.deepEqual(proxyCurlArgs(), [], 'no curl args without a proxy');

    // ── env fallback (Clash) ──
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    assert.equal(outboundProxyUrl(), 'http://127.0.0.1:7890', 'env HTTPS_PROXY must resolve');
    assert.ok(proxyDispatcher(), 'dispatcher must exist once a proxy is set');
    assert.ok(outboundHttpAgent(), 'http agent must exist once a proxy is set');
    assert.deepEqual(proxyCurlArgs(), ['-x', 'http://127.0.0.1:7890'], 'curl args must carry -x');

    // ── keystore PROXY_URL wins over env ──
    const { setKeys } = await import('./keystore.ts');
    await setKeys({ PROXY_URL: 'http://127.0.0.1:8888' });
    assert.equal(outboundProxyUrl(), 'http://127.0.0.1:8888', 'keystore PROXY_URL must win over env');

    // ── cache rebuilds when the URL changes (settings edit takes effect) ──
    await setKeys({ PROXY_URL: 'http://127.0.0.1:9999' });
    assert.equal(outboundProxyUrl(), 'http://127.0.0.1:9999', 'URL change must be picked up');
    assert.ok(proxyDispatcher(), 'dispatcher must rebuild for the new URL');

    // ── clearing the keystore falls back to env again ──
    await setKeys({ PROXY_URL: '' });
    assert.equal(outboundProxyUrl(), 'http://127.0.0.1:7890', 'cleared keystore → env fallback');
    assert.ok(proxyDispatcher(), 'env proxy still active after keystore clear');

    console.log('✓ outbound-proxy verify: keystore/env priority, caching, curl args all passed');
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
