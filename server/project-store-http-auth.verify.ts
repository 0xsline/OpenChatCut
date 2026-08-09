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
} from './project-store-http-auth.ts';

const launchToken = 'launch-token-'.padEnd(48, 'x');
process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN = launchToken;

function request(options: {
  launch?: string;
  session?: string;
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
  return {
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

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
}));
assert.ok(minted && minted.sessionToken.length >= 32, 'valid launch credential should mint a session');
const repeated = exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://localhost:5199',
}));
assert.equal(repeated?.sessionToken, minted.sessionToken,
  'the local launch credential should converge every tab on the active session');
assert.equal(projectStoreHttpAuthorized(request({ launch: launchToken })), false,
  'launch credential must not authorize store operations');
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken })), true,
  'minted session should authorize its bound loopback editor');
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken, host: '127.0.0.1:5199' })), false,
  'session must stay bound to its original Host');
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken, remoteAddress: '::1' })), false,
  'session must stay bound to its original remote address');
resetProjectStoreHttpAuthMemoryForTests();
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken })), false,
  'a server restart must invalidate only the process-local session');

// ── Sessionless READ authorization (other dev ports stay consistent) ────────
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

const restarted = exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://localhost:5199',
}));
assert.ok(restarted, 'the stable local launch credential must recreate a session after restart');
assert.notEqual(restarted.sessionToken, minted.sessionToken,
  'a restarted server must issue a fresh process-local session');
assert.equal(projectStoreHttpAuthorized(request({ session: restarted.sessionToken })), true,
  'the recreated session must authorize editor writes');

resetProjectStoreHttpAuthForTests();
delete process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN;

console.log('project store HTTP session verification passed');
