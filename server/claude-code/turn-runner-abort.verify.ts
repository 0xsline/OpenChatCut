import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaudeCodeTurn } from './turn-runner.ts';
import type { ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent.ts';

/**
 * Aborting a turn must stop the CLI, not just cmd.exe.
 *
 * On Windows `claudeCodeCommand()` runs a `.cmd` through cmd.exe, so the CLI is
 * a grandchild of the spawned child. `child.kill()` ends cmd.exe and lets the
 * CLI keep running — and keep editing the project — after the user pressed
 * Stop. This verifies the grandchild is gone once the turn settles.
 *
 * Windows only: elsewhere the spawned child is the CLI itself, so the plain
 * kill already covers it.
 */
if (process.platform !== 'win32') {
  console.log('claude code abort tree verification skipped (not Windows)');
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), 'occ-abort-tree-'));
const pidFile = join(dir, 'grandchild.pid');
const cliFile = join(dir, 'cli.mjs');
const shimFile = join(dir, 'claude.cmd');

// The grandchild: reports its pid, then stays alive until something kills it.
await writeFile(cliFile, `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`, 'utf8');
// The .cmd shape the runner actually spawns on Windows.
await writeFile(shimFile, `@echo off\r\n"${process.execPath}" "${cliFile}" %*\r\n`, 'utf8');

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const deadline = Date.now() + 20_000;
const control = new AbortController();
const events: ClaudeCodeTurnStreamEvent[] = [];
const turn = runClaudeCodeTurn(
  shimFile,
  { prompt: 'verify abort', approvalMode: 'ask' } as never,
  'http://127.0.0.1:1/mcp',
  'token',
  (event) => events.push(event),
  control.signal,
);

let grandchild = 0;
while (Date.now() < deadline) {
  try {
    grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    if (grandchild > 0) break;
  } catch {
    // not written yet
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
assert(grandchild > 0, 'the fake CLI grandchild never started');
assert(pidAlive(grandchild), 'the grandchild should be running before the abort');

control.abort();
const settled = await Promise.race([
  turn.then(() => 'settled' as const),
  new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
]);
assert.equal(settled, 'settled', 'the aborted turn never settled');

// Give the kill a moment to be reaped, then require the grandchild to be gone.
const goneBy = Date.now() + 10_000;
while (pidAlive(grandchild) && Date.now() < goneBy) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const stillAlive = pidAlive(grandchild);
const remaining = stillAlive
  ? spawnSync('tasklist', ['/FI', `PID eq ${grandchild}`, '/NH'], { encoding: 'utf8' }).stdout?.trim()
  : '';
if (stillAlive) {
  spawnSync('taskkill', ['/pid', String(grandchild), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
await rm(dir, { recursive: true, force: true }).catch(() => {});

assert.equal(stillAlive, false, `the CLI grandchild ${grandchild} survived the abort: ${remaining}`);
assert.equal(events.some((event) => event.type === 'error'), false, 'an aborted turn reports no error');

console.log('claude code abort kills the CLI process tree');
