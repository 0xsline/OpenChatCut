import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateMcpToken, mcpTokenPath } from './mcp-token.ts';

const home = mkdtempSync(join(tmpdir(), 'occ-mcp-token-'));
try {
  // First launch mints a token and persists it; the registered `claude mcp add`
  // command must keep working after the app restarts, so a second load has to
  // return the SAME token rather than minting again.
  const first = loadOrCreateMcpToken({ home });
  assert.equal(first.persisted, true, 'first launch persists the token');
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/, 'token keeps the historical shape');
  const second = loadOrCreateMcpToken({ home });
  assert.equal(second.token, first.token, 'a restart serves the same token');

  // The secret must not be world-readable, and must not live under the movable
  // data dir (which may be a synced folder): HOME-anchored hidden root only.
  const path = mcpTokenPath({ home });
  assert.ok(path.startsWith(join(home, '.openchatcut')), 'token lives under the hidden home root');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'token file is owner-only');
  assert.equal(readFileSync(path, 'utf8').trim(), first.token);

  // Isolated dev profiles keep their own token so two checkouts never share a
  // credential, and the default profile never reads a profile's token.
  const profiled = loadOrCreateMcpToken({ home, profileId: '5a4c1e9e-1111-4222-8333-444455556666' });
  assert.notEqual(profiled.token, first.token, 'profiles are credential-isolated');
  assert.equal(
    loadOrCreateMcpToken({ home, profileId: '5a4c1e9e-1111-4222-8333-444455556666' }).token,
    profiled.token,
    'a profile token is stable too',
  );

  // A malformed file is replaced, not trusted: serving arbitrary file content
  // would turn a corrupted write into the endpoint's credential.
  writeFileSync(path, 'pas-un-jeton\n');
  const healed = loadOrCreateMcpToken({ home });
  assert.match(healed.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(healed.token, 'pas-un-jeton');
  assert.equal(readFileSync(path, 'utf8').trim(), healed.token, 'the healed token is written back');

  // A filesystem that refuses writes degrades to the old per-process token
  // instead of refusing to serve: MCP access survives a read-only HOME.
  const lockedHome = join(home, 'locked');
  mkdirSync(join(lockedHome, '.openchatcut'), { recursive: true });
  chmodSync(join(lockedHome, '.openchatcut'), 0o500);
  try {
    const volatile = loadOrCreateMcpToken({ home: lockedHome });
    assert.equal(volatile.persisted, false, 'unwritable home reports non-persistence');
    assert.match(volatile.token, /^[A-Za-z0-9_-]{43}$/, 'a usable token is still served');
  } finally {
    chmodSync(join(lockedHome, '.openchatcut'), 0o700);
  }

  // The environment override wins without touching the filesystem, which is
  // what pins the token for scripted setups and tests.
  process.env.OPENCHATCUT_MCP_TOKEN = ' jeton-fixe-depuis-env ';
  const { externalMcpToken } = await import('./editor-auth.ts');
  assert.equal(externalMcpToken(), 'jeton-fixe-depuis-env', 'env override wins, trimmed');

  console.log('mcp-token.verify OK');
} finally {
  rmSync(home, { recursive: true, force: true });
}
