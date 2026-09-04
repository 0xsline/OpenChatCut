import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  readBridgeJson,
  routeExternalAgentBridge,
  type BridgeOperations,
} from '../plugins/external-agent-bridge-routes.ts';
import { toMcpContent, toStructuredContent } from './mcp.ts';
import { projectMcpReply } from './mcp-result.ts';
import { mcpServerInstructions } from './mcp-instructions.ts';

const object = { ok: true };
const recoveryInstructions = mcpServerInstructions('test-baseline', 'compatibility');
assert.match(recoveryInstructions, /list_edit_sessions/);
assert.match(recoveryInstructions, /recover_edit_session/);
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

const largeResultBody = JSON.stringify({
  id: 'large-image-result',
  outcome: 'applied',
  value: {
    __images: Array.from({ length: 8 }, (_, frame) => ({
      frame,
      base64: 'a'.repeat(300_000),
      mimeType: 'image/jpeg',
    })),
  },
});
assert(Buffer.byteLength(largeResultBody) > 2 * 1024 * 1024);
await assert.rejects(
  () => readBridgeJson(Readable.from([largeResultBody]) as IncomingMessage),
  /request body too large/,
  'non-result bridge requests retain the 2 MiB control budget',
);
const resultRequest = Object.assign(Readable.from([largeResultBody]), {
  method: 'POST',
  headers: { 'x-openchatcut-editor-registration': 'r'.repeat(43) },
}) as IncomingMessage;
let responseBody = '';
const resultResponse = {
  statusCode: 0,
  setHeader: () => undefined,
  end: (value: string) => { responseBody = value; },
} as unknown as ServerResponse;
let settledImages = 0;
const resultOperations = {
  editorCallBinding: () => null,
  settleEditorCall: (_id, _outcome, value) => {
    settledImages = (value as { __images?: unknown[] }).__images?.length ?? 0;
    return true;
  },
} as BridgeOperations;
await routeExternalAgentBridge(
  resultRequest,
  resultResponse,
  new URL('http://openchatcut.local/result'),
  resultOperations,
);
assert.equal(resultResponse.statusCode, 200);
assert.deepEqual(JSON.parse(responseBody), { ok: true });
assert.equal(settledImages, 8,
  'the actual result route accepts the maximum bounded image batch');
const oversizedResultBody = JSON.stringify({ padding: 'a'.repeat(17 * 1024 * 1024) });
await assert.rejects(
  () => readBridgeJson(Readable.from([oversizedResultBody]) as IncomingMessage, { resultBody: true }),
  /request body too large/,
  'result requests remain bounded above 16 MiB',
);

console.log('external-agent MCP structured content check passed');
