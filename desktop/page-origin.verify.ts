import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('./page-origin.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop development needs a testable page-origin policy');

if (existsSync(moduleUrl)) {
  const { resolveDesktopPageOrigin } = await import(moduleUrl.href);
  const embeddedOrigin = 'http://127.0.0.1:5199';
  const liveOrigin = 'http://localhost:5200';

  assert.equal(resolveDesktopPageOrigin({
    embeddedOrigin,
    configuredDevUrl: liveOrigin,
    packaged: false,
    smoke: false,
  }), liveOrigin, 'development may load an explicit loopback Vite origin');

  assert.equal(resolveDesktopPageOrigin({
    embeddedOrigin,
    configuredDevUrl: liveOrigin,
    packaged: true,
    smoke: false,
  }), embeddedOrigin, 'packaged windows must use the embedded origin');

  assert.equal(resolveDesktopPageOrigin({
    embeddedOrigin,
    configuredDevUrl: liveOrigin,
    packaged: false,
    smoke: true,
  }), embeddedOrigin, 'desktop smoke tests must exercise the embedded server');

  assert.throws(() => resolveDesktopPageOrigin({
    embeddedOrigin,
    configuredDevUrl: 'file:///tmp/stale.html',
    packaged: false,
    smoke: false,
  }), /HTTP/i, 'development origins only allow HTTP(S) URLs');

  assert.throws(() => resolveDesktopPageOrigin({
    embeddedOrigin,
    configuredDevUrl: 'https://example.com/editor',
    packaged: false,
    smoke: false,
  }), /loopback/i, 'remote content must not receive the privileged desktop preload');
}

console.log('desktop page-origin verification passed');
