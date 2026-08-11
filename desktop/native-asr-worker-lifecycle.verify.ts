import assert from 'node:assert/strict';
import { NativeAsrWorkerLifecycle } from './native-asr-worker-lifecycle.ts';

const lifecycle = new NativeAsrWorkerLifecycle();
const first = Promise.withResolvers<void>();
const started: string[] = [];

lifecycle.enqueue(async () => {
  started.push('first');
  lifecycle.terminate();
  await first.promise;
});
lifecycle.enqueue(async () => {
  started.push('second');
});

await Promise.resolve();
assert.deepEqual(started, ['first']);
assert.equal(lifecycle.isTerminal(), true);
first.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(started, ['first'], 'fatal termination must suppress queued requests in the same worker');

lifecycle.enqueue(async () => {
  started.push('late');
});
await Promise.resolve();
assert.deepEqual(started, ['first'], 'fatal termination must reject later worker messages');

console.log('native ASR worker lifecycle verification passed');
