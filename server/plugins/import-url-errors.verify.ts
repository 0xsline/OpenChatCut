import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The remedy depends on whether a proxy is configured, and the proxy is read from the
// keystore of the active profile. Point the profile at an empty directory before the
// module graph loads (keystore resolves its profile at import time) so a developer's own
// PROXY_URL cannot change what this check sees; the env proxy is controlled explicitly.
process.env.OPENCHATCUT_DATA_DIR = mkdtempSync(join(tmpdir(), 'import-url-errors-'));
const PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'PROXY_URL'] as const;
for (const name of PROXY_NAMES) delete process.env[name];

const { PublicConnectTimeoutError, PublicResponseTimeoutError } = await import('../safe-public-fetch.ts');
const { ImportUnreachableError, unreachableImportError } = await import('./import-url-errors.ts');

const REMOTE = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
const withCode = (code: string): Error => Object.assign(new Error(`connect ${code} 159.106.121.75:443`), { code });

// The OS-level connect failure the live app produced: a bare IP and an errno.
const rawTimeout = withCode('ETIMEDOUT');
const timedOut = unreachableImportError(rawTimeout, REMOTE);
assert.ok(timedOut instanceof ImportUnreachableError);
assert.equal(timedOut.code, 'upstream_unreachable');
assert.match(timedOut.message, /commondatastorage\.googleapis\.com/, 'the host must be named, not the IP alone');
assert.match(timedOut.message, /ETIMEDOUT/, 'the errno stays for grep and bug reports');
assert.match(timedOut.message, /PROXY_URL/, 'without a proxy the remedy points at the proxy setting');
assert.equal(timedOut.cause, rawTimeout, 'the raw error is kept as cause for logs');

// Every connectivity errno resolves to the same outcome.
for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']) {
  const described = unreachableImportError(withCode(code), REMOTE);
  assert.ok(described, `${code} must be classified as unreachable`);
  assert.match(described.message, new RegExp(code));
}

// Our own connect-phase timeout is unreachable too, and reports the bound that fired.
const connectTimeout = unreachableImportError(
  new PublicConnectTimeoutError('commondatastorage.googleapis.com', '159.106.121.75', 10_000),
  REMOTE,
);
assert.ok(connectTimeout instanceof ImportUnreachableError);
assert.match(connectTimeout.message, /10000ms/);
assert.match(connectTimeout.message, /159\.106\.121\.75/);
assert.match(connectTimeout.message, /PROXY_URL/);

// A host that connects (or a proxy that pretends to) and then never answers is the same
// outcome for the user, and reports the header bound that fired.
const responseTimeout = unreachableImportError(
  new PublicResponseTimeoutError('commondatastorage.googleapis.com', '159.106.121.75', 30_000),
  REMOTE,
);
assert.ok(responseTimeout instanceof ImportUnreachableError);
assert.match(responseTimeout.message, /commondatastorage\.googleapis\.com/);
assert.match(responseTimeout.message, /30000ms/);
assert.match(responseTimeout.message, /PROXY_URL/);

// With a proxy in use the fix is the proxy's rules, not "configure a proxy".
process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
try {
  const proxied = unreachableImportError(withCode('ECONNRESET'), REMOTE);
  assert.ok(proxied);
  assert.match(proxied.message, /代理也连不上/, 'a proxied failure points at the proxy rules');
  assert.doesNotMatch(proxied.message, /配置 PROXY_URL/);
} finally {
  delete process.env.HTTPS_PROXY;
}

// Anything that is not a connectivity failure is left to the caller's existing handling —
// an HTTP error, a size limit, a plain message — so no other path changes shape.
assert.equal(unreachableImportError(new Error('upstream HTTP 404'), REMOTE), null);
assert.equal(unreachableImportError(withCode('ERR_TLS_CERT_ALTNAME_INVALID'), REMOTE), null);
assert.equal(unreachableImportError('not an error object', REMOTE), null);
assert.equal(unreachableImportError(null, REMOTE), null);

// A malformed remote still yields a usable message rather than throwing inside the catch.
const malformed = unreachableImportError(withCode('ETIMEDOUT'), 'not a url');
assert.ok(malformed);
assert.match(malformed.message, /not a url/);

console.log('import-url error classification checks passed');
