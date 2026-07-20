import assert from 'node:assert/strict';
import { toMcpContent, toStructuredContent } from './mcp.ts';

const object = { ok: true };
assert.equal(toStructuredContent(object), object);
assert.deepEqual(toStructuredContent([{ id: 1 }]), { result: [{ id: 1 }] });
assert.deepEqual(toStructuredContent(null), { result: null });
assert.deepEqual(toStructuredContent('ok'), { result: 'ok' });

const imageResult = {
  __images: [{ frame: 30, base64: 'jpeg-data' }],
  frames: [30, 180, 330],
  layout: 'contact_sheet',
  note: 'three frames',
};
assert.deepEqual(toStructuredContent(imageResult), {
  frames: [30, 180, 330],
  layout: 'contact_sheet',
  note: 'three frames',
  images: [{ frame: 30, mimeType: 'image/jpeg' }],
});
assert.deepEqual(toMcpContent(imageResult), [
  {
    type: 'text',
    text: JSON.stringify(toStructuredContent(imageResult)),
  },
  {
    type: 'image',
    data: 'jpeg-data',
    mimeType: 'image/jpeg',
  },
]);

console.log('external-agent MCP structured content check passed');
