import assert from 'node:assert/strict';
import {
  ImportTokenRegistry,
  importUploadUrl,
  consumeUploadReceipt,
  parseImportTokenScope,
  mintUploadReceipt,
  type ImportTokenScope,
  type ImportTokenUse,
} from './import-token.ts';

let now = 1_000;
let sequence = 0;
const registry = new ImportTokenRegistry({
  maxEntries: 8,
  ttlMs: 100,
  now: () => now,
  createToken: () => `ticket-${sequence += 1}`,
});
const scope: ImportTokenScope = {
  sessionId: 'sess-test',
  assetId: 'asset-1',
  assetType: 'video',
  filename: 'clip.mov',
  projectId: 'project-1',
  method: 'POST',
  contentType: 'video/quicktime',
  expectedBytes: 4,
};
const use: ImportTokenUse = {
  sessionId: scope.sessionId,
  assetId: scope.assetId,
  assetType: scope.assetType,
  filename: scope.filename,
  projectId: scope.projectId,
  method: scope.method,
  contentType: scope.contentType,
};

const valid = registry.mint(scope);
assert.equal(registry.consume(valid.token, use).status, 'accepted');
assert.equal(registry.consume(valid.token, use).status, 'invalid', 'ticket must not replay');

const mismatches: ImportTokenUse[] = [
  { ...use, sessionId: 'sess-other' },
  { ...use, assetId: 'asset-2' },
  { ...use, assetType: 'audio' },
  { ...use, filename: 'other.mov' },
  { ...use, projectId: 'project-2' },
  { ...use, method: 'PUT' },
  { ...use, contentType: 'video/mp4' },
];
for (const mismatch of mismatches) {
  const minted = registry.mint(scope);
  assert.equal(registry.consume(minted.token, mismatch).status, 'mismatch');
  assert.equal(registry.consume(minted.token, use).status, 'invalid');
}

const expired = registry.mint(scope);
now = expired.expiresAt;
assert.equal(registry.consume(expired.token, use).status, 'expired');

let capToken = 0;
const capped = new ImportTokenRegistry({
  maxEntries: 2,
  ttlMs: 10,
  now: () => now,
  createToken: () => `cap-${capToken += 1}`,
});
capped.mint(scope);
capped.mint(scope);
assert.throws(() => capped.mint(scope), /capacity reached/);
now += 10;
const afterPrune = capped.mint(scope);
assert.equal(capped.size, 1, 'mint must prune expired entries before enforcing the cap');
assert.equal(capped.consume(afterPrune.token, use).status, 'accepted');

assert.throws(
  () => parseImportTokenScope({ ...scope, extra: true }),
  /invalid import token request/,
);
assert.throws(
  () => parseImportTokenScope({ ...scope, method: 'PUT' }),
  /invalid import token request/,
);
assert.throws(
  () => registry.mint({ ...scope, filename: '../clip.mov' }),
  /invalid import filename/,
);
assert.throws(
  () => registry.mint({ ...scope, assetType: 'image' }),
  /invalid import asset type or content type/,
  'asset type and MIME must be an allowlisted pair',
);
const displayedUrl = importUploadUrl(scope, 'visible-only-in-issued-url');
assert.match(displayedUrl, /^\/upload\?/);
const displayed = new URL(displayedUrl, 'http://localhost');
assert.equal(displayed.searchParams.get('name'), scope.filename);
assert.equal(displayed.searchParams.get('sessionId'), scope.sessionId);
const receipt = mintUploadReceipt(scope, {
  path: '/media/uploads/asset-1.mov',
  fileKey: 'uploads/asset-1.mov',
  bytes: scope.expectedBytes,
  contentHash: 'ab'.repeat(32),
});
assert.equal(consumeUploadReceipt(receipt, 'wrong-project'), null);
const consumedReceipt = consumeUploadReceipt(receipt, scope.projectId);
assert.equal(consumedReceipt?.sessionId, scope.sessionId);
assert.equal(consumedReceipt?.contentHash, 'ab'.repeat(32));
assert.equal(consumeUploadReceipt(receipt, scope.projectId), null, 'receipt must not replay');
assert.equal(displayed.searchParams.get('assetType'), scope.assetType);

console.log('import token registry verification passed');
