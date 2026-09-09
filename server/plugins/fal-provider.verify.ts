import assert from 'node:assert/strict';
import { runFalQueue, falTask } from './fal-provider.ts';
const calls: string[] = [];
const client = { queue: {
  submit: async (endpoint: string) => { calls.push(`submit:${endpoint}`); return { request_id: 'paid-once' }; },
  subscribeToStatus: async () => { calls.push('poll'); return { status: 'COMPLETED' }; },
  result: async () => { calls.push('result'); return { data: { video: { url: 'https://fal.media/result.mp4' } } }; },
} };
const request = { endpoint: 'bytedance/seedance-2.0/text-to-video', input: { prompt: 'test' } };
let taskId = '';
const result = await runFalQueue(client, request, async (_provider, id) => { calls.push('persist'); taskId = id; });
assert.equal((result as { video: { url: string } }).video.url, 'https://fal.media/result.mp4');
assert.deepEqual(calls, [`submit:${request.endpoint}`, 'persist', 'poll', 'result']);
assert.deepEqual(falTask(taskId), { endpoint: request.endpoint, requestId: 'paid-once' });
calls.length = 0;
await runFalQueue(client, request, async () => { throw new Error('must not resubmit'); }, taskId);
assert.deepEqual(calls, ['poll', 'result']);
assert.throws(() => falTask('fal:not-json'), /Invalid Fal task/);
assert.throws(() => falTask('fal:' + JSON.stringify({ endpoint: 'https://attacker.test', requestId: 'x' })), /Invalid Fal task/);
const failing = { queue: { ...client.queue, result: async () => { throw new Error('Fal rejected request'); } } };
await assert.rejects(runFalQueue(failing, request, async () => {}, taskId), /Fal rejected/);
console.log('Fal queue submit, durable resume and failure verified (mock transport; no credits)');
