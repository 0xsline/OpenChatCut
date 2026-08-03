import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('./page-origin.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop development needs a testable page-origin policy');

if (existsSync(moduleUrl)) {
  const {
    assertTrustedDesktopSenderUrl,
    resolveDesktopPageOrigin,
    resolveDesktopPageUrlDecision,
  } = await import(moduleUrl.href);
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

  assert.deepEqual(
    resolveDesktopPageUrlDecision(`${embeddedOrigin}/editor?project=1`, embeddedOrigin, 'navigation'),
    { action: 'allow' },
    'same-origin navigation remains inside the privileged renderer',
  );
  assert.deepEqual(
    resolveDesktopPageUrlDecision('https://example.com/docs', embeddedOrigin, 'navigation'),
    { action: 'open-external', url: 'https://example.com/docs' },
    'external navigation is handed off instead of replacing the privileged renderer',
  );
  assert.deepEqual(
    resolveDesktopPageUrlDecision('http://example.com/redirected', embeddedOrigin, 'redirect'),
    { action: 'open-external', url: 'http://example.com/redirected' },
    'external redirects are handed off instead of entering the privileged renderer',
  );
  assert.deepEqual(
    resolveDesktopPageUrlDecision(`${embeddedOrigin}/popup`, embeddedOrigin, 'popup'),
    { action: 'deny' },
    'same-origin popups are denied so they cannot create an unguarded privileged window',
  );
  assert.deepEqual(
    resolveDesktopPageUrlDecision('https://example.com/popup', embeddedOrigin, 'popup'),
    { action: 'open-external', url: 'https://example.com/popup' },
    'safe external popups are handed off to the operating system',
  );
  assert.deepEqual(
    resolveDesktopPageUrlDecision('file:///tmp/untrusted.html', embeddedOrigin, 'popup'),
    { action: 'deny' },
    'unsafe popup protocols are denied without an external handoff',
  );

  assert.doesNotThrow(
    () => assertTrustedDesktopSenderUrl(`${embeddedOrigin}/timeline`, embeddedOrigin),
    'same-origin frames may call privileged desktop IPC',
  );
  assert.throws(
    () => assertTrustedDesktopSenderUrl('https://example.com/editor', embeddedOrigin),
    /untrusted desktop IPC sender/,
    'external frames cannot call privileged desktop IPC',
  );
  assert.throws(
    () => assertTrustedDesktopSenderUrl('not a URL', embeddedOrigin),
    /untrusted desktop IPC sender/,
    'missing or malformed sender URLs cannot call privileged desktop IPC',
  );
}

console.log('desktop page-origin verification passed');
