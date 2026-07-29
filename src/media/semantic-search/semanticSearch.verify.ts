import assert from 'node:assert/strict';
import { SEMANTIC_MODEL_VERSION } from './types';
import { findDuplicateAssets, rankSemanticMatches } from './vectorSearch';
import { shouldPruneVector } from './vectorStore';

const records = [
  { scopeId: 'project-a', assetId: 'sunset-a', sampleTime: 0, vector: [1, 0, 0] },
  { scopeId: 'project-a', assetId: 'sunset-a', sampleTime: 4, vector: [0.9701425, 0.2425356, 0] },
  { scopeId: 'project-a', assetId: 'sunset-copy', sampleTime: 0, vector: [0.999, 0.001, 0] },
  { scopeId: 'project-a', assetId: 'sunset-copy', sampleTime: 4, vector: [0.969, 0.247, 0] },
  { scopeId: 'project-a', assetId: 'city', sampleTime: 0, vector: [0, 1, 0] },
];

// Only the frame with the highest score is retained for each asset: sunset-a has two sampling points and should not occupy two places.
// 'city' is orthogonal to the query (score 0), blocked by the relative lower bound.
const matches = rankSemanticMatches(records, [1, 0, 0], 3);
assert.deepEqual(matches.map((item) => item.assetId), ['sunset-a', 'sunset-copy']);
assert.equal(matches[0]?.sampleTime, 0, '留下的是该素材里最贴切的那一帧');
assert.ok((matches[0]?.score ?? 0) > 0.99);

// The relative lower limit is only calculated based on the highest score: the same batch of assets is replaced by a weak query, and the correctly sorted results are still returned instead of empty.
const weak = rankSemanticMatches(records, [0, 1, 0], 5);
assert.deepEqual(weak.map((item) => item.assetId), ['city'], '明显不如最佳命中的不混进来充数');

// When all are orthogonal (highest score ≤ 0), no lower limit is set, and the scores are left to the caller to avoid returning none.
const orthogonal = rankSemanticMatches(records, [0, 0, 1], 5);
assert.equal(orthogonal.length, 3, '三个素材各留一帧');
assert.ok(orthogonal.every((item) => item.score === 0));

const duplicates = findDuplicateAssets(records, 0.995);
assert.deepEqual(duplicates.map((item) => [item.leftAssetId, item.rightAssetId]), [
  ['sunset-a', 'sunset-copy'],
]);

const sharedIntro = [
  { scopeId: 'project-a', assetId: 'video-a', sampleTime: 0, vector: [1, 0, 0] },
  { scopeId: 'project-a', assetId: 'video-a', sampleTime: 10, vector: [0, 0, 1] },
  { scopeId: 'project-a', assetId: 'video-b', sampleTime: 0, vector: [1, 0, 0] },
  { scopeId: 'project-a', assetId: 'video-b', sampleTime: 10, vector: [0, 1, 0] },
];
assert.deepEqual(findDuplicateAssets(sharedIntro, 0.9), []);

const validIds = new Set(['kept']);
assert.equal(shouldPruneVector({ scopeId: 'other', modelVersion: 'old', assetId: 'gone' }, 'project-a', validIds), false);
assert.equal(shouldPruneVector({ scopeId: 'project-a', modelVersion: 'old', assetId: 'kept' }, 'project-a', validIds), true);
assert.equal(shouldPruneVector({ scopeId: 'project-a', modelVersion: SEMANTIC_MODEL_VERSION, assetId: 'gone' }, 'project-a', validIds), true);
