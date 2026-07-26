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

// 每个素材只留最高分那一帧:sunset-a 有两个采样点,不该占掉两个名额。
// 'city' 与查询正交(得分 0),被相对下限挡在外面。
const matches = rankSemanticMatches(records, [1, 0, 0], 3);
assert.deepEqual(matches.map((item) => item.assetId), ['sunset-a', 'sunset-copy']);
assert.equal(matches[0]?.sampleTime, 0, '留下的是该素材里最贴切的那一帧');
assert.ok((matches[0]?.score ?? 0) > 0.99);

// 相对下限只按最高分算:同一批素材换个弱查询,仍然返回排序正确的结果而不是空。
const weak = rankSemanticMatches(records, [0, 1, 0], 5);
assert.deepEqual(weak.map((item) => item.assetId), ['city'], '明显不如最佳命中的不混进来充数');

// 全部正交(最高分 ≤0)时不设下限,交给调用方看分数,免得一条都不返回。
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
