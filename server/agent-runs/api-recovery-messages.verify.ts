import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { decodeApiRecoveryMessages, encodeApiRecoveryMessages } from './api-recovery-messages';

const messages: ModelMessage[] = [
  { role: 'user', content: [
    { type: 'image', image: new URL('https://example.test/still.jpg') },
    { type: 'image', image: Uint8Array.of(0, 17, 254).subarray(1) },
    { type: 'file', data: Uint8Array.of(12, 0, 255).buffer, mediaType: 'image/png' },
  ] },
  { role: 'assistant', content: [
    { type: 'reasoning', text: 'synthetic', providerOptions: { provider: { signature: 'opaque-signature' } } },
    { type: 'tool-call', toolCallId: 'a', toolName: 'inspect', input: {} },
  ] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'inspect',
    output: { type: 'json', value: { version: 1, data: [], special: [{ type: 'url', path: [] }] } } }] },
];
assert.deepEqual(decodeApiRecoveryMessages(encodeApiRecoveryMessages(messages)), messages);
assert.deepEqual(decodeApiRecoveryMessages(encodeApiRecoveryMessages([])), []);
assert.throws(() => decodeApiRecoveryMessages('{"version":1,"data":[],"special":[{"type":"url","path":["__proto__","a"]}]}'));
assert.throws(() => decodeApiRecoveryMessages('{"version":1,"data":["not base64"],"special":[{"type":"bytes","path":[0]}]}'));
console.log('api-recovery-messages.verify: structured history, provider metadata, URLs and byte slices round-trip');
