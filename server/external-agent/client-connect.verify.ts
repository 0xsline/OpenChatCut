// One-click client connect: JSON config merges are idempotent and never
// clobber existing servers; broken JSON is refused; the Codex path drives the
// CLI and keeps the shell export in sync. Runs entirely inside a temp HOME.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectExternalClient } from './client-connect';

const ENDPOINT = 'http://localhost:5199/api/external-mcp/mcp';
const TOKEN = 'tok_AbC123-_xyz';

async function main(): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'occ-connect-'));
  try {
    // 1. Cursor: file created from scratch with the http entry.
    const cursor = await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(cursor.ok, true);
    assert.deepEqual(cursor.paths, ['~/.cursor/mcp.json']);
    const cursorConfig = JSON.parse(await readFile(path.join(home, '.cursor/mcp.json'), 'utf8'));
    assert.equal(cursorConfig.mcpServers.openchatcut.type, 'http');
    assert.equal(cursorConfig.mcpServers.openchatcut.url, ENDPOINT);
    assert.equal(cursorConfig.mcpServers.openchatcut.headers.Authorization, `Bearer ${TOKEN}`);

    // 2. Idempotent reconnect and existing-server preservation.
    await writeFile(
      path.join(home, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2),
    );
    const again = await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(again.ok, true);
    const merged = JSON.parse(await readFile(path.join(home, '.cursor/mcp.json'), 'utf8'));
    assert.equal(merged.mcpServers.other.command, 'other', 'existing server preserved');
    assert.equal(merged.mcpServers.openchatcut.url, ENDPOINT, 'openchatcut rewritten');

    // 3. Invalid JSON is refused without touching the file.
    await writeFile(path.join(home, '.cursor/mcp.json'), '{broken');
    const broken = await connectExternalClient('cursor', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.equal(broken.error, 'config-parse-error');
    assert.equal(await readFile(path.join(home, '.cursor/mcp.json'), 'utf8'), '{broken');

    // 4. Antigravity: httpUrl shape merged into an existing config.
    await mkdir(path.join(home, '.gemini/antigravity'), { recursive: true });
    await writeFile(
      path.join(home, '.gemini/antigravity/mcp_config.json'),
      JSON.stringify({ mcpServers: { keep: { httpUrl: 'http://x' } } }, null, 2),
    );
    const ag = await connectExternalClient('antigravity', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(ag.ok, true);
    const agConfig = JSON.parse(await readFile(path.join(home, '.gemini/antigravity/mcp_config.json'), 'utf8'));
    assert.equal(agConfig.mcpServers.keep.httpUrl, 'http://x');
    assert.equal(agConfig.mcpServers.openchatcut.httpUrl, ENDPOINT);
    assert.equal(agConfig.mcpServers.openchatcut.headers.Authorization, `Bearer ${TOKEN}`);

    // 5. Claude: creates ~/.claude.json with a user-scope mcpServers entry.
    const claude = await connectExternalClient('claude', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(claude.ok, true);
    const claudeConfig = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(claudeConfig.mcpServers.openchatcut.type, 'http');
    assert.equal(claudeConfig.mcpServers.openchatcut.url, ENDPOINT);

    // 6. Codex: stub CLI must receive the right args; .zshrc export is added,
    //    then updated (not duplicated) when the token changes.
    const stubDir = path.join(home, 'bin');
    await mkdir(stubDir, { recursive: true });
    await mkdir(path.join(home, '.codex'), { recursive: true });
    const stub = path.join(stubDir, 'codex-stub');
    await writeFile(stub, '#!/bin/sh\necho "$@" >> "$CODEX_HOME/stub-args"\nexit 0\n');
    await chmod(stub, 0o755);
    const codex = await connectExternalClient('codex', ENDPOINT, TOKEN, { baseDir: home, codexBin: stub });
    assert.equal(codex.ok, true);
    if (codex.ok) assert.deepEqual(codex.paths, ['~/.codex/config.toml', '~/.zshrc']);
    const stubArgs = (await readFile(path.join(home, '.codex/stub-args'), 'utf8')).trim();
    assert.equal(
      stubArgs,
      `mcp add openchatcut --url ${ENDPOINT} --bearer-token-env-var OPENCHATCUT_MCP_TOKEN`,
    );
    const zshrcFirst = await readFile(path.join(home, '.zshrc'), 'utf8');
    assert.match(zshrcFirst, /# OpenChatCut MCP token \(added by OpenChatCut\)\nexport OPENCHATCUT_MCP_TOKEN='tok_AbC123-_xyz'\n$/);
    const rotated = await connectExternalClient('codex', ENDPOINT, 'tok_NEW456', { baseDir: home, codexBin: stub });
    assert.equal(rotated.ok, true);
    const zshrcSecond = await readFile(path.join(home, '.zshrc'), 'utf8');
    assert.match(zshrcSecond, /export OPENCHATCUT_MCP_TOKEN='tok_NEW456'/);
    assert.equal((zshrcSecond.match(/OPENCHATCUT_MCP_TOKEN=/g) ?? []).length, 1, 'no duplicate export');

    // 7. Codex CLI failure surfaces as codex-cli-failed.
    const failStub = path.join(stubDir, 'codex-fail');
    await writeFile(failStub, '#!/bin/sh\necho boom >&2\nexit 3\n');
    await chmod(failStub, 0o755);
    const codexFail = await connectExternalClient('codex', ENDPOINT, TOKEN, { baseDir: home, codexBin: failStub });
    assert.equal(codexFail.ok, false);
    if (!codexFail.ok) {
      assert.equal(codexFail.error, 'codex-cli-failed');
      assert.match(codexFail.detail ?? '', /boom/);
    }

    // 8. Validation: unknown client and malformed token are rejected.
    const badClient = await connectExternalClient('evil', ENDPOINT, TOKEN, { baseDir: home });
    assert.equal(badClient.ok, false);
    const badToken = await connectExternalClient('cursor', ENDPOINT, "'; rm -rf ~", { baseDir: home });
    assert.equal(badToken.ok, false);
    if (!badToken.ok) assert.equal(badToken.error, 'invalid-token');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  console.log('✓ client-connect: merges idempotent, broken JSON refused, codex CLI + env var synced');
}

void main();
