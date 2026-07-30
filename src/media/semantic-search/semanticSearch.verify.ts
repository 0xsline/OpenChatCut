import assert from 'node:assert/strict';
import { SemanticClient } from './semanticClient';
import { resolveSemanticPanelRect } from './semanticPanelPosition';
import {
  SEMANTIC_MODEL_VERSION, type WorkerRequest, type WorkerResponse,
} from './types';
import {
  findDuplicateAssets, findDuplicateAssetsPacked, packSemanticVectors, rankSemanticMatches,
} from './vectorSearch';
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

const exactRecords = records.map((record) => ({ ...record, vector: new Float32Array(record.vector) }));
const exactExpected = findDuplicateAssets(exactRecords, 0.995);
assert.deepEqual(
  findDuplicateAssetsPacked(packSemanticVectors(exactRecords), 0.995),
  exactExpected,
  'packed full-scan results preserve pair order, scores, and threshold behavior exactly',
);

class FakeSemanticWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  requests: WorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.requests.push(structuredClone(message, { transfer }) as WorkerRequest);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: WorkerResponse): void {
    this.onmessage?.call(this as unknown as Worker, { data: response } as MessageEvent<WorkerResponse>);
  }
}

const fakeWorker = new FakeSemanticWorker();
const client = new SemanticClient(() => fakeWorker as unknown as Worker);
const staleController = new AbortController();
const stalePromise = client.findDuplicateAssets(exactRecords, 0.995, staleController.signal);
const staleRequest = fakeWorker.requests[0] as Extract<WorkerRequest, { type: 'find-duplicates' }>;
assert.equal(staleRequest.type, 'find-duplicates');
assert.equal(fakeWorker.transfers[0]?.length, 3, 'all packed numeric buffers are transferred');
staleController.abort();
await assert.rejects(stalePromise, { name: 'AbortError' });

const currentPromise = client.findDuplicateAssets(exactRecords, 0.995);
const currentRequest = fakeWorker.requests[1] as Extract<WorkerRequest, { type: 'find-duplicates' }>;
fakeWorker.respond({
  id: staleRequest.id,
  type: 'result',
  result: { type: 'duplicates', matches: [{ leftAssetId: 'stale', rightAssetId: 'result', score: 1 }] },
});
let currentSettled = false;
void currentPromise.then(
  () => { currentSettled = true; },
  () => { currentSettled = true; },
);
await Promise.resolve();
assert.equal(currentSettled, false, 'a stale response cannot settle the current request');
fakeWorker.respond({
  id: currentRequest.id,
  type: 'result',
  result: {
    type: 'duplicates',
    matches: findDuplicateAssetsPacked(currentRequest.vectors, currentRequest.threshold),
  },
});
assert.deepEqual(await currentPromise, exactExpected);

const canceledPromise = client.findDuplicateAssets(exactRecords);
client.cancel();
await assert.rejects(canceledPromise, { name: 'AbortError' });
assert.equal(fakeWorker.terminated, true, 'cancel terminates the worker and rejects pending requests');
const resumedPromise = client.findDuplicateAssets(exactRecords);
const resumedRequest = fakeWorker.requests[3] as Extract<WorkerRequest, { type: 'find-duplicates' }>;
fakeWorker.respond({
  id: resumedRequest.id,
  type: 'result',
  result: {
    type: 'duplicates',
    matches: findDuplicateAssetsPacked(resumedRequest.vectors, resumedRequest.threshold),
  },
});
assert.deepEqual(await resumedPromise, exactExpected, 'StrictMode cleanup can restart the semantic worker after canceling it');
const disposedPromise = client.findDuplicateAssets(exactRecords);
client.dispose();
await assert.rejects(disposedPromise, { name: 'AbortError' });

const validIds = new Set(['kept']);
assert.equal(shouldPruneVector({ scopeId: 'other', modelVersion: 'old', assetId: 'gone' }, 'project-a', validIds), false);
assert.equal(shouldPruneVector({ scopeId: 'project-a', modelVersion: 'old', assetId: 'kept' }, 'project-a', validIds), true);
assert.equal(shouldPruneVector({ scopeId: 'project-a', modelVersion: SEMANTIC_MODEL_VERSION, assetId: 'gone' }, 'project-a', validIds), true);

const panelBounds = { top: 40, bottom: 700, left: 320, right: 700, width: 380 };
assert.deepEqual(
  resolveSemanticPanelRect(
    { top: 80, bottom: 108, left: 520, right: 548, width: 28 },
    panelBounds,
    { width: 1280, height: 800 },
    280,
  ),
  { top: 114, left: 330, width: 340 },
  'the floating panel stays inside the media library instead of being clipped by it',
);
assert.equal(
  resolveSemanticPanelRect(
    { top: 720, bottom: 748, left: 520, right: 548, width: 28 },
    panelBounds,
    { width: 1280, height: 800 },
    280,
  ).top,
  434,
  'the floating panel opens above the trigger near the viewport edge',
);
