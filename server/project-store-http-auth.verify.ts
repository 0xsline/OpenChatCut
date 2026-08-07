import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  exchangeProjectStoreLaunchToken,
  PROJECT_STORE_LAUNCH_TOKEN_HEADER,
  PROJECT_STORE_SESSION_HEADER,
  projectStoreHttpAuthorized,
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
} = {}): IncomingMessage {
  const headers: Record<string, string> = { host: options.host ?? 'localhost:5199' };
  if (options.origin !== undefined) headers.origin = options.origin;
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
assert.equal(exchangeProjectStoreLaunchToken(request({
  launch: launchToken,
  origin: 'http://localhost:5199',
})), null, 'launch credential must be single-use');
assert.equal(projectStoreHttpAuthorized(request({ launch: launchToken })), false,
  'launch credential must not authorize store operations');
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken })), true,
  'minted session should authorize its bound loopback editor');
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken, host: '127.0.0.1:5199' })), false,
  'session must stay bound to its original Host');
assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken, remoteAddress: '::1' })), false,
  'session must stay bound to its original remote address');

const originalNow = Date.now;
Date.now = () => minted.expiresAt + 1;
try {
  assert.equal(projectStoreHttpAuthorized(request({ session: minted.sessionToken })), false,
    'expired session must be rejected');
} finally {
  Date.now = originalNow;
  resetProjectStoreHttpAuthForTests();
  delete process.env.OPENCHATCUT_EDITOR_LAUNCH_TOKEN;
}

console.log('project store HTTP session verification passed');
