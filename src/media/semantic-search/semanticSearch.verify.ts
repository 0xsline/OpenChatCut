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

const matches = rankSemanticMatches(records, [1, 0, 0], 3);
assert.deepEqual(matches.map((item) => item.assetId), ['sunset-a', 'sunset-copy', 'sunset-a']);
assert.equal(matches[0]?.sampleTime, 0);
assert.ok((matches[0]?.score ?? 0) > 0.99);

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
