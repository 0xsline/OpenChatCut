import assert from 'node:assert/strict';
import { executeModelPackMutation } from './model-pack-actions';

const originalWindow = globalThis.window;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    openChatCutDesktop: {
      editorCredentials: async () => ({
        credential: 'pane-editor-secret',
        mcpToken: 'unused-mcp-secret',
      }),
    },
  },
});

try {
  let receivedId: string | null = null;
  const receivedHeaders: Headers[] = [];
  await executeModelPackMutation('music-semantics-lite', async (id, headers) => {
    receivedId = id;
    receivedHeaders.push(new Headers(headers));
  });

  assert.equal(receivedId, 'music-semantics-lite');
  assert.equal(receivedHeaders.length, 1);
  assert.equal(receivedHeaders[0]?.get('x-openchatcut-editor-credential'), 'pane-editor-secret');
} finally {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: originalWindow,
    });
  }
}

console.log('model-pack-pane.verify: editor credential forwarded');
