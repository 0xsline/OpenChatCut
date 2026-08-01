import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent.ts';
import { CODEX_DISABLED_FEATURES, CodexAppServerClient } from './app-server.ts';
import { codexCommand } from './command.ts';
import { CodexTurnManager } from './turn-manager.ts';

const windowsShim = codexCommand(
  'C:\\Program Files\\Open&AI\\codex.cmd',
  ['--version', 'model=name&danger'],
  'win32',
);
assert.match(windowsShim.executable, /cmd\.exe$/i);
assert.equal(windowsShim.windowsVerbatimArguments, true);
assert.deepEqual(windowsShim.args.slice(0, 3), ['/d', '/s', '/c']);
assert.equal(windowsShim.args.length, 4, 'cmd.exe receives one escaped command after /c');
assert.match(windowsShim.args[3], /^"C:\\Program\^ Files\\Open\^&AI\\codex\.cmd /);
assert.match(windowsShim.args[3], /\^"model=name\^&danger\^""$/);

const FAKE_APP_SERVER = String.raw`
import { createInterface } from 'node:readline';


const requiredFeatureArgs = ${JSON.stringify(CODEX_DISABLED_FEATURES.map((feature) => `features.${feature}=false`))};
if (requiredFeatureArgs.some((arg) => !process.argv.includes(arg))) process.exit(71);
if (!process.argv.includes('tools.view_image=false') || !process.argv.includes('web_search=disabled')) process.exit(71);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let activeThread = '';
let activeTurn = '';

function toolRequest() {
  send({
    id: 'dynamic-1',
    method: 'item/tool/call',
    params: {
      threadId: activeThread,
      turnId: activeTurn,
      callId: 'call-1',
      tool: 'read_project',
      arguments: { section: 'timeline' },
    },
  });
}

function connectorRequest() {
  send({
    id: 'connector-1',
    method: 'item/tool/call',
    params: {
      threadId: activeThread,
      turnId: activeTurn,
      callId: 'connector-call-1',
      tool: 'google_drive_search',
      arguments: { query: 'private files' },
    },
  });
}

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) process.exit(72);
    send({ id: message.id, result: { serverInfo: { name: 'fake-codex' } } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    send({ id: message.id, result: { account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' } } });
    return;
  }
  if (message.method === 'account/login/start') {
    const device = message.params.type === 'chatgptDeviceCode';
    const loginId = device ? 'login-2' : 'login-1';
    send({
      id: message.id,
      result: device
        ? { type: message.params.type, loginId, verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-1234' }
        : { type: message.params.type, loginId, authUrl: 'https://auth.openai.com/test' },
    });
    if (!device) send({ method: 'account/login/completed', params: { loginId, success: true } });
    return;
  }
  if (message.method === 'account/login/cancel') {
    if (message.params.loginId !== 'login-2') process.exit(76);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'test/hang') return;
  if (message.method === 'thread/start') {
    activeThread = 'thread-1';
    send({ id: message.id, result: { thread: { id: activeThread } } });
    return;
  }
  if (message.method === 'turn/start') {
    activeTurn = 'turn-1';
    send({ id: message.id, result: { turn: { id: activeTurn } } });
    send({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: activeThread, turnId: activeTurn },
    });
    return;
  }
  if (message.id === 'approval-1') {
    if (message.result?.decision !== 'decline') process.exit(73);
    connectorRequest();
    return;
  }
  if (message.id === 'connector-1') {
    if (message.result?.success !== false) process.exit(75);
    toolRequest();
    return;
  }
  if (message.id === 'dynamic-1') {
    if (message.result?.success !== true) process.exit(74);
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: activeThread, turnId: activeTurn, delta: 'Tool confirmed.' },
    });
    send({
      method: 'turn/completed',
      params: { threadId: activeThread, turn: { id: activeTurn, status: 'completed' } },
    });
    return;
  }
  if (message.method === 'thread/delete' || message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
});
`;

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-codex-verify-'));
const scriptPath = join(directory, 'fake-app-server.mjs');
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousAccessToken = process.env.CODEX_ACCESS_TOKEN;
process.env.OPENAI_API_KEY = 'must-not-reach-codex';
process.env.CODEX_ACCESS_TOKEN = 'must-not-reach-codex';
await writeFile(scriptPath, FAKE_APP_SERVER, 'utf8');

const client = new CodexAppServerClient(process.execPath, [scriptPath]);
try {
  const account = await client.request('account/read', { refreshToken: false });
  assert.deepEqual(account, {
    account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' },
  });

  const login = await client.startLogin('chatgpt');
  assert.deepEqual(login, {
    type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/test',
  });
  await delay(0);
  assert.equal(client.loginPending, false, 'a fast completion must not leave stale pending login state');

  await client.startLogin('chatgptDeviceCode');
  assert.equal(client.loginPending, true, 'device login remains pending until cancelled');
  await client.cancelPendingLogins();
  assert.equal(client.loginPending, false, 'cancel-all clears pending login state across UI mounts');

  const controller = new AbortController();
  const hanging = client.request('test/hang', {}, { signal: controller.signal });
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(hanging, /cancelled by test/);

  const manager = new CodexTurnManager();
  const events: CodexTurnStreamEvent[] = [];
  await manager.run(client, {
    requestId: 'request-1',
    system: 'Use OpenChatCut tools.',
    prompt: 'Read the current project.',
    projectId: 'project-1',
    model: 'gpt-5.4',
    tools: [{
      name: 'read_project',
      description: 'Read project state',
      inputSchema: { type: 'object', properties: { section: { type: 'string' } } },
    }],
  }, (event) => {
    events.push(event);
    if (event.type === 'tool-start') {
      assert.equal(manager.settleToolResult({
        requestId: 'request-1',
        callId: event.callId,
        success: true,
        result: { projectId: 'project-1' },
      }), 'ok');
    }
  }, new AbortController().signal);

  assert.equal(manager.hasRequest('request-1'), false);
  assert.deepEqual(events.map((event) => event.type), [
    'tool-start', 'tool-end', 'text-delta', 'done',
  ]);
  assert.equal(events.find((event) => event.type === 'text-delta')?.delta, 'Tool confirmed.');
} finally {
  client.stop();
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
  else process.env.CODEX_ACCESS_TOKEN = previousAccessToken;
  await rm(directory, { recursive: true, force: true });
}

console.log('codex agent verification passed');
