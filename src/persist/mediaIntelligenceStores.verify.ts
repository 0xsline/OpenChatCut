import assert from 'node:assert/strict';
import { kvSet, resetSharedKvMemory } from './sharedKv';
import {
  loadTranscriptionCheckpoint,
  resetTranscriptionCheckpointQueues,
  saveTranscriptionCheckpoint,
  updateTranscriptionCheckpoint,
  type TranscriptionCheckpoint,
} from './transcriptionJobStore';
import {
  loadVadEvidence,
  resetVadEvidenceQueues,
  saveVadEvidence,
  type VadEvidence,
} from './vadEvidenceStore';

resetSharedKvMemory();
resetTranscriptionCheckpointQueues();
resetVadEvidenceQueues();

const base: TranscriptionCheckpoint = {
  projectId: 'project-a',
  assetId: 'asset-a',
  sourceRevision: 'rev-a',
  provider: 'assemblyai',
  providerStatus: 'submitted',
  providerJobId: 'job-1',
  uploadUrl: 'https://upload/1',
  languageCode: 'zh',
  retry: { attempts: 0, lastAttemptAt: 1 },
  createdAt: 1,
  updatedAt: 1,
};
const legacyCheckpoint: Partial<TranscriptionCheckpoint> = { ...base };
delete legacyCheckpoint.projectId;
await kvSet('transcription-job:asset-a:rev-a', legacyCheckpoint);
assert.equal(await loadTranscriptionCheckpoint(base), null, 'legacy projectless checkpoints are not reused');
await saveTranscriptionCheckpoint(base);
await Promise.all(Array.from({ length: 12 }, () => updateTranscriptionCheckpoint(base, (current) => ({
  ...current!,
  retry: { ...current!.retry, attempts: current!.retry.attempts + 1 },
  updatedAt: current!.updatedAt + 1,
}))));
assert.equal((await loadTranscriptionCheckpoint(base))?.retry.attempts, 12, 'read-modify-write jobs serialize per asset revision without lost updates');

await assert.rejects(() => updateTranscriptionCheckpoint(base, () => {
  throw new Error('simulated checkpoint failure');
}));
await updateTranscriptionCheckpoint(base, (current) => ({
  ...current!, providerStatus: 'processing', updatedAt: current!.updatedAt + 1,
}));
assert.equal((await loadTranscriptionCheckpoint(base))?.providerStatus, 'processing', 'one rejected write cannot permanently reject the logical-key queue');

const otherProject: TranscriptionCheckpoint = {
  ...base,
  projectId: 'project-b',
  providerJobId: 'job-2',
  uploadUrl: 'https://upload/2',
};
await saveTranscriptionCheckpoint(otherProject);
assert.equal((await loadTranscriptionCheckpoint(base))?.providerJobId, 'job-1', 'same asset revision remains isolated in project A');
assert.equal((await loadTranscriptionCheckpoint(otherProject))?.providerJobId, 'job-2', 'same asset revision remains isolated in project B');
assert.equal((await loadTranscriptionCheckpoint(base))?.uploadUrl, 'https://upload/1');
assert.equal((await loadTranscriptionCheckpoint(otherProject))?.uploadUrl, 'https://upload/2');

const vadKey = {
  assetId: 'asset-a', sourceRevision: 'rev-a', model: 'silero', modelVersion: 'v5', threshold: 0.5,
};
const evidence = (analyzedAt: number): VadEvidence => ({
  ...vadKey,
  confidence: 0.9,
  speechSpans: [{ startMs: 10, endMs: 20, confidence: 0.9 }],
  analyzedAt,
});
await Promise.all(Array.from({ length: 8 }, (_, index) => saveVadEvidence(evidence(index))));
assert.equal((await loadVadEvidence(vadKey))?.analyzedAt, 7, 'VAD writes for one evidence key retain call order');
await saveVadEvidence({ ...evidence(9), threshold: 0.7 });
assert.equal((await loadVadEvidence(vadKey))?.analyzedAt, 7, 'threshold is part of the VAD evidence identity');
assert.equal((await loadVadEvidence({ ...vadKey, threshold: 0.7 }))?.analyzedAt, 9);

resetSharedKvMemory();
resetTranscriptionCheckpointQueues();
resetVadEvidenceQueues();
console.log('mediaIntelligenceStores.verify: ok');
