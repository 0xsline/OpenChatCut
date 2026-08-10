import assert from 'node:assert/strict';
import { executeModelPackMutation } from './model-pack-actions';

try {
  let receivedId: string | null = null;
  const receivedHeaders: Headers[] = [];
  await executeModelPackMutation('music-semantics-lite', async (id, headers) => {
    receivedId = id;
    receivedHeaders.push(new Headers(headers));
  });

  assert.equal(receivedId, 'music-semantics-lite');
  assert.equal(receivedHeaders.length, 1);
  for (const name of receivedHeaders[0]?.keys() ?? []) {
    assert.ok(!/x-openchatcut/i.test(name),
      `model-pack mutations must not carry credential headers (found ${name})`);
  }
  assert.equal(receivedHeaders[0]?.get('x-openchatcut-editor-credential'), null,
    'no editor credential header may be attached');
} finally {
  // Nothing else to restore: the mutation helper is pure now.
}

console.log('model-pack-pane.verify: loopback trust forwarded');
