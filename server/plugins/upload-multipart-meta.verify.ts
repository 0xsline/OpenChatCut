import assert from 'node:assert/strict';
import { enqueueMetaWrite, queuedMetaWriteCount } from './upload-multipart-meta.ts';

const order: number[] = [];
const first = enqueueMetaWrite('upload-a', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  order.push(1);
});
const failed = enqueueMetaWrite('upload-a', async () => {
  order.push(2);
  throw new Error('expected');
});
const recovered = enqueueMetaWrite('upload-a', async () => { order.push(3); });

await first;
await assert.rejects(failed, /expected/);
await recovered;
await Promise.resolve();

assert.deepEqual(order, [1, 2, 3], 'metadata writes must stay serialized after a failure');
assert.equal(queuedMetaWriteCount(), 0, 'settled upload queues must be released');
console.log('upload multipart metadata queue verification passed');
