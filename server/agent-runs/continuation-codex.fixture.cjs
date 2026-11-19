#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.146.0'); process.exit(0); }
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
let attempt = 0;
let threadId;
let turnId;
const fail = (code, reason) => { process.stderr.write(reason + '\n'); process.exit(code); };
const call = (id, name, args) => send({ id: 'dynamic-' + id, method: 'item/tool/call',
  params: { threadId, turnId, callId: id, tool: name, arguments: args } });
createInterface({ input: process.stdin }).on('line', raw => {
  const message = JSON.parse(raw);
  if (message.method === 'initialize') {
    if (process.env.CODEX_HOME !== join(__dirname, '.openchatcut', 'codex')) fail(81, 'profile leaked');
    if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) fail(82, 'external key leaked');
    send({ id: message.id, result: { serverInfo: { name: 'continuation-fixture' } } });
  } else if (message.method === 'initialized') {
    return;
  } else if (message.method === 'thread/start') {
    attempt += 1;
    threadId = 'continuation-thread-' + attempt;
    turnId = 'continuation-turn-' + attempt;
    if (attempt > 2) fail(83, 'duplicate continuation started a third thread');
    send({ id: message.id, result: { thread: { id: threadId } } });
  } else if (message.method === 'turn/start') {
    const input = JSON.stringify(message.params.input);
    appendFileSync(join(__dirname, 'codex-inputs.jsonl'), JSON.stringify({ attempt, threadId, input }) + '\n');
    if (attempt === 2 && (!input.includes('Continue and use English subtitles.') || !input.includes('continuation-edit-receipt'))) {
      fail(84, 'continuation omitted the new instruction or confirmed B result');
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (attempt === 1) call('B', 'edit_item', { updates: [{ type: 'video', itemId: 'clip-7', durationInFrames: 120 }] });
    else call('B', 'read_timeline', {}); // A fresh thread intentionally reuses the raw call id.
  } else if (message.id === 'dynamic-B' && attempt === 1) {
    if (!message.result?.success || !JSON.stringify(message.result).includes('continuation-edit-receipt')) fail(85, 'B result lost');
    send({ method: 'error', params: { threadId, turnId, willRetry: false,
      error: { message: 'Explicit continuation fixture provider failure', codexErrorInfo: 'badRequest' } } });
  } else if (message.id === 'dynamic-B' && attempt === 2) {
    if (!message.result?.success) fail(86, 'C result failed');
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: 'English subtitles confirmed.' } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  } else if (message.method === 'thread/delete' || message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
  } else send({ id: message.id, error: { code: -32601, message: 'unsupported fixture request' } });
}).on('close', () => process.exit(0));
