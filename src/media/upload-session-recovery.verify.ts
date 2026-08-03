import assert from 'node:assert/strict';
import { isExpiredMultipartSessionError, retryExpiredMultipartSession } from './upload';

assert.equal(isExpiredMultipartSessionError(new Error('upload session not found or expired')), true);
assert.equal(isExpiredMultipartSessionError(new Error('missing parts: 2')), false);

let attempts = 0;
const recovered = await retryExpiredMultipartSession(async () => {
  attempts += 1;
  if (attempts === 1) throw new Error('upload session not found or expired');
  return 'fresh-upload-path';
});
assert.equal(recovered, 'fresh-upload-path');
assert.equal(attempts, 2);

await assert.rejects(
  () =>
    retryExpiredMultipartSession(async () => {
      throw new Error('upload session not found or expired');
    }),
  /上传会话已失效，请重新导入/,
);

console.log('upload-session-recovery.verify: stale sessions retry once');
