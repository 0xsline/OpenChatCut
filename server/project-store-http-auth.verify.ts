import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  exchangeProjectStoreLaunchToken,
  PROJECT_STORE_LAUNCH_TOKEN_HEADER,
  PROJECT_STORE_SESSION_HEADER,
  projectStoreHttpAuthorized,
  projectStoreReadAuthorized,
  resetProjectStoreHttpAuthMemoryForTests,
  resetProjectStoreHttpAuthForTests,
  PROJECT_STORE_SESSION_COOKIE,
  signEditorSession,
} from './project-store-http-auth.ts';

const launchToken = 'launch-token-'.padEnd(48, 'x');
process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN = launchToken;

function request(options: {
  launch?: string;
  session?: string;
  cookie?: string;
  host?: string;
  origin?: string;
  remoteAddress?: string;
  secFetchSite?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = { host: options.host ?? 'localhost:5199' };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite;
  if (options.launch !== undefined) headers[PROJECT_STORE_LAUNCH_TOKEN_HEADER] = options.launch;
  if (options.session !== undefined) headers[PROJECT_STORE_SESSION_HEADER] = options.session;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return {
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

const HOST = 'localhost:5199';

resetProjectStoreHttpAuthForTests();
assert.equal(exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://localhost:5199',
  remoteAddress: '192.168.1.10',
})), null, 'launch exchange must be loopback-only');
assert.equal(exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://evil.test',
})), null, 'launch exchange must require same origin');

const minted = exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://localhost:5199',
}))!;
assert.ok(minted.sessionToken.length >= 32, 'valid launch credential should mint a session');

// ── Stateless signed session survives a "restart" (no process memory) ─────
// The sessionToken is HMAC-signed from the persistent launch token, so there
// is no process-local state to lose. Re-exchanging on the same host must yield
// the SAME token (it is a pure function of host + signer key).
const reissued = exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://localhost:5199',
}))!;
assert.equal(reissued.sessionToken, minted.sessionToken,
  'the stable local launch credential must recreate an identical signed session (stateless)');
assert.equal(
  projectStoreHttpAuthorized(request({ session: minted.sessionToken })),
  true,
  'minted session should authorize its bound loopback editor',
);
assert.equal(
  projectStoreHttpAuthorized(request({ session: minted.sessionToken, host: '127.0.0.1:5199' })),
  false,
  'signed session must stay bound to the host it was minted for',
);
assert.equal(
  projectStoreHttpAuthorized(request({ session: minted.sessionToken, remoteAddress: '192.168.1.10' })),
  false,
  'session must only authorize loopback remote addresses',
);

// ── Browser cookie path (the shipped mechanism) ───────────────────────────
const signedCookie = signEditorSession(HOST);
const withCookie = request({ cookie: `${PROJECT_STORE_SESSION_COOKIE}=${signedCookie}` });
assert.equal(
  projectStoreHttpAuthorized(withCookie),
  true,
  'signed HttpOnly cookie should authorize the editor',
);
const wrongHostCookie = request({
  cookie: `${PROJECT_STORE_SESSION_COOKIE}=${signEditorSession('127.0.0.1:9999')}`,
});
assert.equal(
  projectStoreHttpAuthorized(wrongHostCookie),
  false,
  'a cookie signed for a different Host must not authorize',
);
const tamperedCookie = request({
  cookie: `${PROJECT_STORE_SESSION_COOKIE}=${signEditorSession(HOST).slice(0, -2)}x`,
});
assert.equal(
  projectStoreHttpAuthorized(tamperedCookie),
  false,
  'a tampered cookie signature must be rejected',
);

// ── Sessionless READ authorization (other dev ports stay consistent) ──────
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin' })), true,
  'same-origin browser request may read without a session');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin', host: '127.0.0.1:5202' })), true,
  '127.0.0.1 host may read without a session');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin', host: 'localhost:5202' })), true,
  'other dev ports may read without a session');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'none' })), true,
  'direct local navigation (curl) may read');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'cross-site' })), false,
  'cross-site pages must not read (PNA/Sec-Fetch-Site enforced)');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin', remoteAddress: '192.168.1.10' })), false,
  'read authorization stays loopback-only on the socket');
assert.equal(projectStoreReadAuthorized(request({})), false,
  'missing Sec-Fetch-Site never authorizes reads');

// ── Reset is a no-op for persistent signed sessions ───────────────────────
resetProjectStoreHttpAuthMemoryForTests();
assert.equal(
  projectStoreHttpAuthorized(request({ session: minted.sessionToken })),
  true,
  'signed sessions must survive a reset (no process-local memory)',
);
assert.equal(
  projectStoreHttpAuthorized(request({ cookie: `${PROJECT_STORE_SESSION_COOKIE}=${signedCookie}` })),
  true,
  'signed cookie must survive a reset',
);

resetProjectStoreHttpAuthForTests();
delete process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN;

console.log('project store HTTP session verification passed');
