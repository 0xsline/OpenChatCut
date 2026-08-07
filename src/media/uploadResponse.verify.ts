import assert from 'node:assert/strict';
import { uploadedMediaLocation } from './uploadResponse';

const hash = 'ab'.repeat(32);
assert.deepEqual(
  uploadedMediaLocation({ path: '/media/uploads/example.mov', contentHash: hash.toUpperCase() }),
  { src: '/media/uploads/example.mov', sourceContentHash: hash },
  'single and multipart responses expose one normalized browser identity shape',
);
assert.deepEqual(
  uploadedMediaLocation({ path: '/media/uploads/legacy.mov' }),
  { src: '/media/uploads/legacy.mov' },
  'legacy upload servers without contentHash remain readable',
);
assert.deepEqual(
  uploadedMediaLocation({ path: '/media/uploads/invalid.mov', contentHash: `${hash}0` }),
  { src: '/media/uploads/invalid.mov' },
  'malformed hash metadata is ignored rather than becoming source identity',
);
assert.equal(uploadedMediaLocation({ path: 'https://example.com/file.mov', contentHash: hash }), null);

console.log('uploadResponse.verify: upload content identity propagation passed');
