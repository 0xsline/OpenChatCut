import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent.ts';
import { claudeCodeCommand } from './command.ts';
import { isSupportedClaudeCodeVersion, MINIMUM_CLAUDE_CODE_VERSION } from './installation.ts';
import { runClaudeCodeTurn, translateClaudeCodeLine } from './turn-runner.ts';

// -- version parsing / support gate -----------------------------------------
assert.equal(isSupportedClaudeCodeVersion(MINIMUM_CLAUDE_CODE_VERSION), true);
assert.equal(isSupportedClaudeCodeVersion('1.9.9'), false, 'below the floor is unsupported');
assert.equal(isSupportedClaudeCodeVersion('2.1.260'), true, 'the installed dev version is supported');
assert.equal(isSupportedClaudeCodeVersion(null), false);

// -- Windows command-escaping safety (mirrors server/codex/command.ts) ------
const windowsShim = claudeCodeCommand(
  'C:\\Program Files\\Anthropic&Co\\claude.cmd',
  ['--version', 'model=name&danger'],
  'win32',
);
assert.match(windowsShim.executable, /cmd\.exe$/i);
assert.equal(windowsShim.windowsVerbatimArguments, true);
assert.deepEqual(windowsShim.args.slice(0, 3), ['/d', '/s', '/c']);
assert.equal(windowsShim.args.length, 4, 'cmd.exe receives one escaped command after /c');
assert.match(windowsShim.args[3], /^"C:\\Program\^ Files\\Anthropic\^&Co\\claude\.cmd /);
assert.match(windowsShim.args[3], /\^"model=name\^&danger\^""$/);

const posixCommand = claudeCodeCommand('/usr/local/bin/claude', ['--version'], 'linux');
assert.deepEqual(posixCommand, { executable: '/usr/local/bin/claude', args: ['--version'] });

// -- translateClaudeCodeLine: pure event-translation coverage ---------------
{
  const pending = new Map<string, { name: string; args: unknown }>();
  const init = translateClaudeCodeLine(
    { type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'openchatcut', status: 'connected' }] },
    pending,
  );
  assert.deepEqual(init, [{ type: 'session', sessionId: 'sess-1' }]);

  const assistantText = translateClaudeCodeLine(
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } },
    pending,
  );
  assert.deepEqual(assistantText, [{ type: 'text-delta', delta: 'hello world' }]);

  const assistantThinking = translateClaudeCodeLine(
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'reasoning...' }] } },
    pending,
  );
  assert.deepEqual(assistantThinking, [{ type: 'thinking-delta', delta: 'reasoning...' }]);

  const toolUse = translateClaudeCodeLine(
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__openchatcut__read_project', input: { a: 1 } }] },
    },
    pending,
  );
  assert.deepEqual(toolUse, [{ type: 'tool-start', callId: 'call-1', name: 'mcp__openchatcut__read_project', args: { a: 1 } }]);
  assert.equal(pending.has('call-1'), true, 'pending tool-use is tracked by callId for later tool-end pairing');

  const toolResult = translateClaudeCodeLine(
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] } },
    pending,
  );
  assert.deepEqual(toolResult, [{
    type: 'tool-end', callId: 'call-1', name: 'mcp__openchatcut__read_project', args: { a: 1 }, result: 'ok', success: true,
  }]);
  assert.equal(pending.has('call-1'), false, 'settled tool-use is removed from the pending map');

  const failedToolResult = translateClaudeCodeLine(
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'boom', is_error: true }] } },
    pending,
  );
  assert.deepEqual(failedToolResult, [{
    type: 'tool-end', callId: 'call-2', name: 'unknown', args: null, result: 'boom', success: false,
  }]);

  const success = translateClaudeCodeLine(
    {
      type: 'result', subtype: 'success', result: 'done', is_error: false,
      modelUsage: { sonnet: { inputTokens: 10, outputTokens: 5, contextWindow: 200000, cacheReadInputTokens: 2 } },
    },
    pending,
  );
  assert.deepEqual(success, [
    { type: 'context-usage', inputTokens: 10, contextWindowTokens: 200000, outputTokens: 5, cacheReadTokens: 2 },
    { type: 'done' },
  ]);

  const failure = translateClaudeCodeLine(
    { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'ran out of turns' },
    pending,
  );
  assert.deepEqual(failure, [{ type: 'error', message: 'ran out of turns' }, { type: 'done' }]);
}

// -- runClaudeCodeTurn: full subprocess pipeline via a fake `claude` CLI ----
const FAKE_CLI = String.raw`
import { existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
function has(flag) { return args.includes(flag); }
function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
if (!has('--strict-mcp-config')) process.exit(61);
if (!has('--allowedTools') || valueAfter('--allowedTools') !== 'mcp__openchatcut-builtin__*') process.exit(62);
if (!has('--permission-mode') || valueAfter('--permission-mode') !== 'bypassPermissions') process.exit(63);
if (!has('--mcp-config')) process.exit(64);
// Regression guard: the MCP server this turn spawns must NOT be named plain
// "openchatcut". Claude Code caches auth failures by server NAME in
// ~/.claude/mcp-needs-auth-cache.json, so sharing the name with a user- or
// project-scoped "openchatcut" entry (the repo's own .mcp.json is one) lets a
// single unrelated auth failure route this bearer-authenticated config into the
// OAuth path, hiding every editor tool behind authenticate/complete_authentication.
const mcpConfigPath = valueAfter('--mcp-config');
if (!mcpConfigPath || !existsSync(mcpConfigPath)) process.exit(70);
const mcpServers = JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers ?? {};
const serverNames = Object.keys(mcpServers);
if (serverNames.length !== 1) process.exit(71);
if (serverNames[0] === 'openchatcut') process.exit(72);
if (!valueAfter('--allowedTools').includes(serverNames[0])) process.exit(73);
if (!mcpServers[serverNames[0]].headers?.Authorization?.startsWith('Bearer ')) process.exit(74);
// The system prompt must arrive as a FILE. Inline (--append-system-prompt)
// overflows the ~32KB Windows command-line cap for a real OpenChatCut system
// prompt and spawn dies with ENAMETOOLONG.
if (has('--append-system-prompt')) process.exit(65);
if (!has('--append-system-prompt-file')) process.exit(66);
const promptFile = valueAfter('--append-system-prompt-file');
if (!promptFile || !existsSync(promptFile)) process.exit(67);
if (!readFileSync(promptFile, 'utf8').includes('OpenChatCut')) process.exit(68);
// Guard the whole command line, not just the system prompt.
if (args.join(' ').length > 8000) process.exit(69);
const promptIndex = args.indexOf('-p');
if (promptIndex === -1 || args[promptIndex + 1] !== 'trigger-error') {
  const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  send({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
  send({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
  send({
    type: 'result', subtype: 'success', result: 'ok', is_error: false,
    modelUsage: { sonnet: { inputTokens: 3, outputTokens: 1, contextWindow: 200000 } },
  });
  process.exit(0);
} else {
  process.stderr.write('fake failure reason');
  process.exit(1);
}
`;

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-claude-code-verify-'));
const scriptPath = join(directory, 'fake-claude.mjs');
await writeFile(scriptPath, FAKE_CLI, 'utf8');
let shimPath = scriptPath;
if (process.platform === 'win32') {
  shimPath = join(directory, 'fake-claude.cmd');
  await writeFile(shimPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8');
} else {
  await writeFile(scriptPath, `#!/usr/bin/env node\n${FAKE_CLI}`, 'utf8');
  await chmod(scriptPath, 0o755);
}

try {
  {
    const events: ClaudeCodeTurnStreamEvent[] = [];
    await runClaudeCodeTurn(
      shimPath,
      { requestId: 'req-1', system: 'sys', prompt: 'hello', projectId: 'proj-1' },
      'http://127.0.0.1:1/api/external-mcp/mcp',
      'fake-token',
      (event) => events.push(event),
      new AbortController().signal,
    );
    assert.deepEqual(events, [
      { type: 'session', sessionId: 'fake-session-1' },
      { type: 'text-delta', delta: 'ok' },
      { type: 'context-usage', inputTokens: 3, contextWindowTokens: 200000, outputTokens: 1, cacheReadTokens: undefined },
      { type: 'done' },
    ], 'a successful fake turn translates init/text/usage/done in order');
  }
  {
    // Regression: a real OpenChatCut system prompt is tens of KB. Passed inline
    // it blew the ~32KB Windows command-line cap and spawn failed with
    // ENAMETOOLONG before the CLI ever started. 200KB here is far past any
    // platform limit, so this fails loudly if the prompt returns to argv.
    const huge = `OpenChatCut ${'x'.repeat(200_000)}`;
    const events: ClaudeCodeTurnStreamEvent[] = [];
    await runClaudeCodeTurn(
      shimPath,
      { requestId: 'req-big', system: huge, prompt: 'hello', projectId: 'proj-1' },
      'http://127.0.0.1:1/api/external-mcp/mcp',
      'fake-token',
      (event) => events.push(event),
      new AbortController().signal,
    );
    assert.ok(
      events.some((event) => event.type === 'done'),
      'a 200KB system prompt still spawns: it goes in a file, not on the command line',
    );
    assert.ok(
      !events.some((event) => event.type === 'error'),
      'no ENAMETOOLONG (or any spawn error) for an oversized system prompt',
    );
  }
  {
    const events: ClaudeCodeTurnStreamEvent[] = [];
    await runClaudeCodeTurn(
      shimPath,
      { requestId: 'req-2', system: 'sys', prompt: 'trigger-error', projectId: 'proj-1' },
      'http://127.0.0.1:1/api/external-mcp/mcp',
      'fake-token',
      (event) => events.push(event),
      new AbortController().signal,
    );
    assert.equal(events.length, 2, 'a non-zero exit with no result event emits error then done');
    assert.equal(events[0].type, 'error');
    assert.match((events[0] as { message: string }).message, /fake failure reason/);
    assert.equal(events[1].type, 'done');
  }
} finally {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write('claude-code-agent.verify.ts: ok\n');
