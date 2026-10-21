import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent.ts';
import { claudeCodeCommand } from './command.ts';
import { isSupportedClaudeCodeVersion, MINIMUM_CLAUDE_CODE_VERSION } from './installation.ts';
import {
  clearClaudeCodeModelCache,
  FALLBACK_CLAUDE_CODE_MODELS,
  listClaudeCodeModels,
  parseClaudeCodeModels,
  requestClaudeCodeModels,
} from './models.ts';
import { runClaudeCodeTurn, translateClaudeCodeLine } from './turn-runner.ts';

// -- version parsing / support gate -----------------------------------------
assert.equal(isSupportedClaudeCodeVersion(MINIMUM_CLAUDE_CODE_VERSION), true);
assert.equal(isSupportedClaudeCodeVersion('1.9.9'), false, 'below the floor is unsupported');
assert.equal(isSupportedClaudeCodeVersion('2.1.262'), false, 'one build below the sandbox-flag floor is unsupported');
assert.equal(isSupportedClaudeCodeVersion('2.1.263'), true, 'the verified version is supported');
assert.equal(isSupportedClaudeCodeVersion('2.2.0'), true, 'newer versions stay supported');
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
  assert.deepEqual(assistantText, [{ type: 'text-delta', delta: 'hello world', startsMessage: true }]);

  const assistantThinking = translateClaudeCodeLine(
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'reasoning...' }] } },
    pending,
  );
  assert.deepEqual(assistantThinking, [{ type: 'thinking-delta', delta: 'reasoning...', startsMessage: true }]);

  // Only the FIRST chunk of each kind opens a message: blocks inside one
  // `assistant` line are contiguous prose and must not gain a paragraph break.
  const multiBlock = translateClaudeCodeLine(
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'first thought' },
          { type: 'text', text: 'first half' },
          { type: 'thinking', thinking: 'second thought' },
          { type: 'text', text: ' second half' },
        ],
      },
    },
    pending,
  );
  assert.deepEqual(multiBlock, [
    { type: 'thinking-delta', delta: 'first thought', startsMessage: true },
    { type: 'text-delta', delta: 'first half', startsMessage: true },
    { type: 'thinking-delta', delta: 'second thought' },
    { type: 'text-delta', delta: ' second half' },
  ]);

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

// -- parseClaudeCodeModels: the `initialize` control_response ---------------
// Shape recorded from Claude Code 2.1.302: a `default` entry that only points at
// a model, aliases and pinned ids that resolve to the same model, and extras
// (supportedEffortLevels, description) the picker does not use.
const initResponse = (models: unknown, subtype = 'success') => ({
  type: 'control_response',
  response: { subtype, request_id: 'openchatcut-models', response: { models, account: {} } },
});
const CLI_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'high'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5 (pinned)' },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
];
const PARSED_CLI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', isDefault: false },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', isDefault: false },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', isDefault: false },
];
assert.deepEqual(parseClaudeCodeModels(initResponse(CLI_MODELS)), PARSED_CLI_MODELS,
  'ids are resolvedModel, duplicates collapse to the first label, and the default is marked once');
assert.deepEqual(
  parseClaudeCodeModels(initResponse([
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
    { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)' },
  ]))?.map((model) => [model.id, model.isDefault]),
  [['claude-sonnet-5-5', true], ['claude-opus-5-5', false]],
  'the CLI default moves first: the composer falls back to the first entry, not to isDefault',
);
assert.deepEqual(
  parseClaudeCodeModels(initResponse([
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)',
      description: 'Opus 5.5 · Best for everyday, complex tasks' },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
  ])),
  [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', isDefault: false },
  ],
  'a default no alias names still appears, labelled from its description, never "Default (recommended)"',
);
assert.deepEqual(
  parseClaudeCodeModels(initResponse([
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
    { value: 'broken', displayName: 'No resolved model' },
    'not an object',
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5' },
  ])),
  [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', isDefault: true },
    { id: 'claude-haiku-5-5', label: 'claude-haiku-5-5', isDefault: false },
  ],
  'without a default entry the first model is the default; malformed entries are skipped',
);
assert.equal(parseClaudeCodeModels(initResponse(CLI_MODELS, 'error')), null, 'an error response is no answer');
assert.equal(parseClaudeCodeModels(initResponse('nope')), null, 'models must be an array');
assert.equal(parseClaudeCodeModels(initResponse([{ value: 'x' }])), null, 'no usable entry is no answer');
assert.equal(parseClaudeCodeModels({ type: 'control_response' }), null);
assert.equal(parseClaudeCodeModels(null), null);


function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// -- runClaudeCodeTurn: full subprocess pipeline via a fake `claude` CLI ----
const FAKE_CLI = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
function has(flag) { return args.includes(flag); }
function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
if (!has('--strict-mcp-config')) process.exit(61);
if (!has('--allowedTools') || valueAfter('--allowedTools') !== 'mcp__openchatcut-builtin__*') process.exit(62);
// The turn must run sandboxed: restricted mode + deny list + fail-closed prompts.
// bypassPermissions is refused by --restricted (2.1.263) and must never come back.
if (has('--permission-mode')) process.exit(63);
if (!has('--restricted')) process.exit(65);
if (valueAfter('--permission-prompts') !== 'none') process.exit(66);
if (!has('--disallowedTools')) process.exit(67);
for (const denied of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']) {
  if (!valueAfter('--disallowedTools').split(' ').includes(denied)) process.exit(68);
}
// Restricted mode scopes file tools to the working directory, so the child must
// not inherit the app checkout as its cwd. Compare the directory NAME (the
// mkdtemp prefix) — tmpdir() and cwd() disagree on macOS through /var symlinks.
if (!process.cwd().split(/[\\/]/).pop().startsWith('occ-claude-code-')) process.exit(69);
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
const prompt = promptIndex === -1 ? '' : args[promptIndex + 1];
if (prompt.startsWith('hang-forever:')) {
  // Announce the session first, then report the pid: the caller waits for both
  // before aborting, so the abort cannot race the parent's read of this line.
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-session-hang' }) + '\n');
  writeFileSync(prompt.slice('hang-forever:'.length), String(process.pid));
  setInterval(() => {}, 1000);
} else if (prompt !== 'trigger-error') {
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
      { type: 'text-delta', delta: 'ok', startsMessage: true },
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
  {
    // The turn timeout kills the CLI by aborting this signal
    // (server/agent-runs/claude-code-turn.ts). A child that outlives its turn
    // keeps a live MCP bearer token and write access to the project, so the
    // abort has to actually terminate the process, not just stop reading it.
    const pidFile = join(directory, 'hang.pid');
    const controller = new AbortController();
    const events: ClaudeCodeTurnStreamEvent[] = [];
    const turn = runClaudeCodeTurn(
      shimPath,
      { requestId: 'req-hang', system: 'sys', prompt: `hang-forever:${pidFile}`, projectId: 'proj-1' },
      'http://127.0.0.1:1/api/external-mcp/mcp',
      'fake-token',
      (event) => events.push(event),
      controller.signal,
    );
    let pid = 0;
    // Both conditions matter: the child must exist to be killed, and its first
    // line must already have reached the parent, or the abort races the read
    // and the stream assertion below sees nothing.
    for (let attempt = 0; attempt < 400 && !(pid && events.length); attempt += 1) {
      await sleep(25);
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    }
    assert.ok(pid > 0, 'the fake CLI reported its pid before the abort');
    controller.abort();
    await turn;
    assert.deepEqual(events, [{ type: 'session', sessionId: 'fake-session-hang' }],
      'an aborted turn emits no terminal error: the caller already knows it aborted');
    // Windows spawns through a cmd.exe shim, so the pid here is a grandchild
    // that `child.kill()` does not necessarily reach; assert the guarantee on
    // the platforms where the CLI is the direct child.
    if (process.platform !== 'win32') {
      let alive = true;
      for (let attempt = 0; attempt < 400 && alive; attempt += 1) {
        await sleep(25);
        try { process.kill(pid, 0); } catch { alive = false; }
      }
      assert.equal(alive, false, 'aborting the turn terminates the CLI child');
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

// -- listClaudeCodeModels: real subprocess, cache and fallback --------------
// The child gets an allow-listed environment, so the fake reads its mode from a
// file beside itself and counts its launches in another.
const FAKE_MODELS_CLI = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const here = new URL('.', import.meta.url);
const mode = readFileSync(new URL('mode.txt', here), 'utf8').trim();
appendFileSync(new URL('launches.txt', here), 'x');
const args = process.argv.slice(2);
for (const flag of ['-p', '--verbose', '--restricted']) if (!args.includes(flag)) process.exit(81);
if (args[args.indexOf('--input-format') + 1] !== 'stream-json') process.exit(82);
if (args[args.indexOf('--output-format') + 1] !== 'stream-json') process.exit(83);
if (mode === 'crash') process.exit(3);
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
setTimeout(() => process.exit(0), 5000);
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type !== 'control_request' || request.request.subtype !== 'initialize') process.exit(84);
  if (mode === 'hang') return;
  process.stdout.write('not json\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'someone-else', response: { models: [] } } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: request.request_id, response: { models: MODELS } } }) + '\n');
});
`;

const modelsDirectory = await mkdtemp(join(tmpdir(), 'openchatcut-claude-code-models-'));
try {
  const script = join(modelsDirectory, 'fake-claude-models.mjs');
  await writeFile(script, `const MODELS = ${JSON.stringify(CLI_MODELS)};\n${FAKE_MODELS_CLI}`, 'utf8');
  let cli = script;
  if (process.platform === 'win32') {
    cli = join(modelsDirectory, 'fake-claude-models.cmd');
    await writeFile(cli, `@echo off\r\nnode "${script}" %*\r\n`, 'utf8');
  } else {
    await writeFile(script, `#!/usr/bin/env node\nconst MODELS = ${JSON.stringify(CLI_MODELS)};\n${FAKE_MODELS_CLI}`, 'utf8');
    await chmod(script, 0o755);
  }
  const setMode = (mode: string) => writeFile(join(modelsDirectory, 'mode.txt'), mode, 'utf8');
  const launches = async () => (await readFile(join(modelsDirectory, 'launches.txt'), 'utf8').catch(() => '')).length;

  await setMode('ok');
  assert.deepEqual(await requestClaudeCodeModels(cli), PARSED_CLI_MODELS,
    'the initialize answer is read over stdio, skipping noise and other request ids');

  clearClaudeCodeModelCache();
  const before = await launches();
  const [first, second] = await Promise.all([listClaudeCodeModels(cli, '9.0.0'), listClaudeCodeModels(cli, '9.0.0')]);
  assert.deepEqual(first, { models: PARSED_CLI_MODELS });
  assert.deepEqual(second, first);
  assert.equal(await launches() - before, 1, 'concurrent callers share one CLI process');
  assert.deepEqual(await listClaudeCodeModels(cli, '9.0.0'), first);
  assert.equal(await launches() - before, 1, 'a cached answer does not respawn the CLI');
  await listClaudeCodeModels(cli, '9.0.1');
  assert.equal(await launches() - before, 2, 'a new CLI version asks again');

  await setMode('hang');
  await assert.rejects(requestClaudeCodeModels(cli, 400), /timed out/);
  assert.deepEqual(await listClaudeCodeModels(cli, 'hang', 400), { models: FALLBACK_CLAUDE_CODE_MODELS },
    'a CLI that never answers falls back to the curated list, with no error that would empty the picker');

  await setMode('crash');
  await assert.rejects(requestClaudeCodeModels(cli), /exited with code 3/);
  assert.deepEqual(await listClaudeCodeModels(cli, 'crash'), { models: FALLBACK_CLAUDE_CODE_MODELS });
  assert.deepEqual(await listClaudeCodeModels(join(modelsDirectory, 'missing-claude'), null),
    { models: FALLBACK_CLAUDE_CODE_MODELS }, 'a CLI that cannot spawn falls back too');
} finally {
  await rm(modelsDirectory, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write('claude-code-agent.verify.ts: ok\n');
