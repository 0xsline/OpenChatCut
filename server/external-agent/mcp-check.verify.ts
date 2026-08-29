import assert from 'node:assert/strict';
import { toMcpContent, toStructuredContent } from './mcp.ts';
import { projectMcpReply } from './mcp-result.ts';

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
const projectedImage = projectMcpReply(imageResult) as typeof imageResult;
assert.equal(projectedImage.__images[0]!.base64, 'jpeg-data', 'MCP projection preserves image bytes');

console.log('external-agent MCP structured content check passed');
