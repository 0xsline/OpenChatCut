import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  projectStoreHttpAuthorized,
  projectStoreReadAuthorized,
  resetProjectStoreHttpAuthForTests,
} from './project-store-http-auth.ts';

function request(options: {
  host?: string;
  origin?: string;
  remoteAddress?: string;
  secFetchSite?: string;
} = {}): IncomingMessage {
  const headers: Record<string, string> = { host: options.host ?? 'localhost:5199' };
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.secFetchSite !== undefined) headers['sec-fetch-site'] = options.secFetchSite;
  return {
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

resetProjectStoreHttpAuthForTests();

// ── WRITE authorization: loopback + same-origin + browser-enforced ──────────
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5199',
  secFetchSite: 'same-origin',
})), true, 'same-origin loopback editor request may write');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://127.0.0.1:5199',
  secFetchSite: 'same-origin',
  host: '127.0.0.1:5199',
})), true, '127.0.0.1 loopback editor request may write');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5202',
  secFetchSite: 'same-origin',
  host: 'localhost:5202',
})), true, 'other local dev ports may write');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5199',
  secFetchSite: 'same-origin',
  remoteAddress: '192.168.1.10',
})), false, 'writes must stay loopback-only on the socket');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://evil.test',
  secFetchSite: 'same-origin',
})), false, 'a cross-origin page must not write (Origin mismatch)');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5199',
  secFetchSite: 'cross-site',
})), false, 'cross-site form posts must not write (Sec-Fetch-Site enforced)');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5199',
  secFetchSite: 'none',
})), true, 'a browser-enforced same-origin request with direct-navigation marker may write');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5199',
})), false, 'missing Sec-Fetch-Site never authorizes writes');
assert.equal(projectStoreHttpAuthorized(request({
  origin: 'http://localhost:5199',
  secFetchSite: 'same-origin',
  remoteAddress: '::1',
})), true, 'IPv6 loopback writes are trusted');
assert.equal(projectStoreHttpAuthorized(request({})), false,
  'missing headers never authorize writes');

// ── READ authorization: loopback + browser-enforced (no Origin needed) ──────
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin' })), true,
  'same-origin browser request may read');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin', host: '127.0.0.1:5202' })), true,
  '127.0.0.1 host may read');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin', host: 'localhost:5202' })), true,
  'other dev ports may read');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'none' })), true,
  'direct local navigation (curl) may read');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'cross-site' })), false,
  'cross-site pages must not read (Sec-Fetch-Site enforced)');
assert.equal(projectStoreReadAuthorized(request({ secFetchSite: 'same-origin', remoteAddress: '192.168.1.10' })), false,
  'read authorization stays loopback-only on the socket');
assert.equal(projectStoreReadAuthorized(request({})), false,
  'missing Sec-Fetch-Site never authorizes reads');

resetProjectStoreHttpAuthForTests();

console.log('project store HTTP trust verification passed');
