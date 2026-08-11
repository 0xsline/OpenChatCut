import assert from 'node:assert/strict';
import {
  ImportTokenRegistry,
  abortUploadReceipt,
  claimUploadReceipt,
  commitUploadReceipt,
  importUploadUrl,
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
assert.equal(claimUploadReceipt(receipt, 'wrong-project').status, 'mismatch');
const firstClaim = claimUploadReceipt(receipt, scope.projectId);
assert.equal(firstClaim.status, 'accepted');
if (firstClaim.status !== 'accepted') throw new Error('receipt claim should be accepted');
assert.equal(firstClaim.value.sessionId, scope.sessionId);
assert.equal(firstClaim.value.contentHash, 'ab'.repeat(32));
const repeatedClaim = claimUploadReceipt(receipt, scope.projectId, firstClaim.claimId);
assert.equal(repeatedClaim.status, 'accepted', 'retrying the same claim id must be idempotent');
assert.equal(
  claimUploadReceipt(receipt, scope.projectId).status,
  'claimed',
  'a concurrent finalizer must not acquire the same receipt',
);
assert.equal(abortUploadReceipt(receipt, scope.projectId, firstClaim.claimId), true);
const retryClaim = claimUploadReceipt(receipt, scope.projectId);
assert.equal(retryClaim.status, 'accepted', 'abort must restore receipt retryability');
if (retryClaim.status !== 'accepted') throw new Error('receipt retry claim should be accepted');
assert.equal(commitUploadReceipt(receipt, scope.projectId, retryClaim.claimId), true);
assert.equal(
  commitUploadReceipt(receipt, scope.projectId, retryClaim.claimId),
  true,
  'repeating the matching commit is idempotent',
);
assert.equal(
  claimUploadReceipt(receipt, scope.projectId).status,
  'consumed',
  'a committed receipt must reject terminal replay',
);

const originalDateNow = Date.now;
let receiptNow = originalDateNow();
Date.now = () => receiptNow;
try {
  const crossingReceipt = mintUploadReceipt(scope, {
    path: '/media/uploads/asset-crossing.mov',
    fileKey: 'uploads/asset-crossing.mov',
    bytes: scope.expectedBytes,
    contentHash: 'cd'.repeat(32),
  });
  receiptNow += 9 * 60_000;
  const crossingClaim = claimUploadReceipt(
    crossingReceipt,
    scope.projectId,
    'crossing-claim-id'.padEnd(32, '_'),
  );
  assert.equal(crossingClaim.status, 'accepted');
  if (crossingClaim.status !== 'accepted') throw new Error('cross-expiry claim should be accepted');
  const originalClaimExpiry = crossingClaim.claimExpiresAt;
  receiptNow += 2 * 60_000;
  const renewedClaim = claimUploadReceipt(
    crossingReceipt,
    scope.projectId,
    crossingClaim.claimId,
  );
  assert.equal(renewedClaim.status, 'accepted');
  if (renewedClaim.status !== 'accepted') throw new Error('same claim renewal should be accepted');
  assert.ok(
    renewedClaim.claimExpiresAt > originalClaimExpiry,
    'same-claim renewal after receipt expiry must extend a fresh bounded lease',
  );
  receiptNow += 4 * 60_000;
  assert.equal(
    claimUploadReceipt(crossingReceipt, scope.projectId).status,
    'claimed',
    'a different claimant cannot use the superseded lease expiry to evict the renewed claim',
  );
  assert.equal(
    commitUploadReceipt(crossingReceipt, scope.projectId, crossingClaim.claimId),
    true,
    'the renewed claim must settle after its original lease and receipt have expired',
  );
  mintUploadReceipt(scope, {
    path: '/media/uploads/prune-trigger.mov',
    fileKey: 'uploads/prune-trigger.mov',
    bytes: scope.expectedBytes,
    contentHash: 'ef'.repeat(32),
  });
  assert.equal(
    commitUploadReceipt(crossingReceipt, scope.projectId, crossingClaim.claimId),
    true,
    'pruning after cross-expiry commit must preserve the idempotent retry tombstone',
  );
  assert.equal(claimUploadReceipt(crossingReceipt, scope.projectId).status, 'consumed');
} finally {
  Date.now = originalDateNow;
}
assert.equal(displayed.searchParams.get('assetType'), scope.assetType);

console.log('import token registry verification passed');
