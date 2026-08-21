// xAI OAuth session module: CLI auth.json parsing, refresh request shape,
// and the persisted session file round trip. Runs against a throwaway HOME so
// the real Grok CLI session and the real profile files are never touched.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const throwawayHome = mkdtempSync(join(tmpdir(), 'xai-oauth-verify-'));
process.env.HOME = throwawayHome;
// Intentionally dynamic: the module resolves its profile paths (HOME-rooted)
// at import time, so the throwaway HOME must exist before it loads.
const mod = await import('./xai-oauth-session.ts');
const { parseGrokAuthJson, refreshTokens, persistSession, readSessionFile, dropSessionFile } = mod;

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const OUTER_KEY = `https://auth.x.ai::${CLIENT_ID}`;

function cliDoc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    [OUTER_KEY]: {
      key: 'at-jwt',
      refresh_token: 'refresh-1',
      expires_at: Date.now() + 3600_000,
      email: 'user@example.com',
      ...overrides,
    },
  });
}

// ── CLI auth.json parsing ───────────────────────────────────────────────────

const parsed = parseGrokAuthJson(cliDoc());
assert.ok(parsed, 'canonical CLI session parses');
assert.equal(parsed.access, 'at-jwt');
assert.equal(parsed.refresh, 'refresh-1');
assert.equal(parsed.clientId, CLIENT_ID);
assert.equal(parsed.email, 'user@example.com');

assert.equal(parseGrokAuthJson('not json'), null, 'non-JSON rejected');
assert.equal(parseGrokAuthJson(JSON.stringify({})), null, 'empty doc rejected');
assert.equal(
  parseGrokAuthJson(JSON.stringify({ ['https://evil.example::' + CLIENT_ID]: { key: 'a', refresh_token: 'b' } })),
  null,
  'foreign issuer rejected',
);
assert.equal(
  parseGrokAuthJson(cliDoc({ refresh_token: undefined })),
  null,
  'missing refresh token rejected',
);

// ── Refresh request shape (mocked fetch, no network) ────────────────────────

const calls: Array<{ url: string; method: string; body: URLSearchParams }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({
    url: String(input),
    method: init?.method ?? 'GET',
    body: new URLSearchParams(String(init?.body ?? '')),
  });
  return new Response(JSON.stringify({
    access_token: 'at-jwt-2',
    refresh_token: 'refresh-2',
    expires_in: 3000,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const rotated = await refreshTokens(parsed);
assert.equal(rotated.access, 'at-jwt-2', 'new access token adopted');
assert.equal(rotated.refresh, 'refresh-2', 'rotated refresh token adopted');
assert.equal(calls.length, 1);
assert.equal(calls[0].url, 'https://auth.x.ai/oauth2/token');
assert.equal(calls[0].method, 'POST');
assert.equal(calls[0].body.get('grant_type'), 'refresh_token');
assert.equal(calls[0].body.get('refresh_token'), 'refresh-1');
assert.equal(calls[0].body.get('client_id'), CLIENT_ID);

// Rotation fallback: no rotated refresh token → keep the previous one.
calls.length = 0;
globalThis.fetch = (async () => new Response(JSON.stringify({
  access_token: 'at-jwt-3',
  expires_in: 3000,
}), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
const unrotated = await refreshTokens(parsed);
assert.equal(unrotated.refresh, 'refresh-1', 'absent rotation keeps the stored refresh token');

// Terminal failure surfaces the OAuth error code.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), {
  status: 400, headers: { 'content-type': 'application/json' },
})) as typeof fetch;
await assert.rejects(() => refreshTokens(parsed), /invalid_grant/);

globalThis.fetch = originalFetch;

// ── Session file round trip (throwaway HOME) ────────────────────────────────

dropSessionFile();
assert.equal(readSessionFile(), null, 'missing file reads as no session');
persistSession(rotated);
const reloaded = readSessionFile();
assert.ok(reloaded, 'persisted session reads back');
assert.equal(reloaded.access, 'at-jwt-2');
assert.equal(reloaded.clientId, CLIENT_ID);
writeFileSync(join(throwawayHome, '.openchatcut', 'xai-oauth-session.json'), '{broken', 'utf8');
assert.equal(readSessionFile(), null, 'corrupt file reads as no session');
dropSessionFile();

console.log('xai-oauth-session.verify: parsing + refresh shape + session file OK');
