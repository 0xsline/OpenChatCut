import assert from 'node:assert/strict';
import type { AgentContext } from '../agent/context';
import { runtimeGuardForTool } from '../agent/runtime';
import { executeGenerateCommand } from '../agent/tools/generate-tool-handlers';
import {
  acknowledgeIngestedGenerationResults,
  applyGenerationJobReports,
  listTrackedJobs,
  listOpenJobs,
  patchTrackedJobs,
  registerTrackedJob,
  resumeOpenGenerationJobs,
  resetJobRegistryMemory,
  resolveTrackedJob,
} from './jobRegistryStore';

resetJobRegistryMemory();
const projectId = 'project:job-registry-verify';
await Promise.all(Array.from({ length: 24 }, (_, index) => registerTrackedJob({
  operationId: `operation-${index}`,
  jobId: `operation-${index}`,
  projectId,
  status: 'queued',
  toolName: 'submit_video',
  submitArgs: { model: 'kling', prompt: `shot ${index}` },
})));
const concurrent = await listTrackedJobs(projectId);
assert.equal(concurrent.length, 24, 'same-project concurrent registration must not lose rows');

await patchTrackedJobs(projectId, concurrent.slice(0, 8).map((job) => ({
  operationId: job.operationId,
  jobId: job.jobId,
  patch: { status: 'running', providerTaskId: `provider-${job.operationId}` },
})));
const patched = await listTrackedJobs(projectId);
assert.equal(patched.filter((job) => job.status === 'running').length, 8, 'batched progress patches must update every target in one transaction');

const historyProjectId = 'project:job-registry-history-verify';
await registerTrackedJob({
  operationId: 'history-oldest-running',
  jobId: 'history-oldest-running',
  projectId: historyProjectId,
  status: 'running',
});
await registerTrackedJob({
  operationId: 'history-oldest-retryable',
  jobId: 'history-oldest-retryable',
  projectId: historyProjectId,
  status: 'failed',
  retryClass: 'download-retryable',
});
for (let index = 0; index < 85; index += 1) {
  await registerTrackedJob({
    operationId: `history-terminal-${index}`,
    jobId: `history-terminal-${index}`,
    projectId: historyProjectId,
    status: 'succeeded',
  });
}
const retainedHistory = await listTrackedJobs(historyProjectId);
assert.equal(retainedHistory.length, 82, 'the terminal cap must not consume running or retryable rows');
assert.ok(retainedHistory.some((job) => job.operationId === 'history-oldest-running'));
assert.ok(retainedHistory.some((job) => job.operationId === 'history-oldest-retryable'));
assert.deepEqual(
  retainedHistory
    .filter((job) => job.operationId.startsWith('history-terminal-'))
    .map((job) => job.operationId),
  Array.from({ length: 80 }, (_, index) => `history-terminal-${84 - index}`),
  'terminal history must retain only the newest 80 rows',
);

await patchTrackedJobs(historyProjectId, [{
  operationId: 'history-oldest-running',
  jobId: 'history-oldest-running',
  patch: { status: 'succeeded' },
}]);
const afterRunningSettled = await listTrackedJobs(historyProjectId);
assert.equal(
  afterRunningSettled.filter((job) => job.operationId.startsWith('history-terminal-')).length,
  79,
  'a formerly running row must enter terminal history on the next write',
);
assert.ok(afterRunningSettled.some((job) => job.operationId === 'history-oldest-running'));
assert.ok(afterRunningSettled.some((job) => job.operationId === 'history-oldest-retryable'));
assert.equal(
  afterRunningSettled.some((job) => job.operationId === 'history-terminal-5'),
  false,
  'settling an open row must evict the oldest terminal history row, not a recoverable row',
);

const concurrentOpenProjectId = 'project:job-registry-concurrent-open-verify';
for (let index = 0; index < 85; index += 1) {
  await registerTrackedJob({
    operationId: `concurrent-terminal-${index}`,
    jobId: `concurrent-terminal-${index}`,
    projectId: concurrentOpenProjectId,
    status: 'succeeded',
  });
}
await Promise.all(Array.from({ length: 96 }, (_, index) => registerTrackedJob({
  operationId: `concurrent-open-${index}`,
  jobId: `concurrent-open-${index}`,
  projectId: concurrentOpenProjectId,
  status: index % 2 === 0 ? 'queued' : 'submitting',
})));
const concurrentOpen = await listTrackedJobs(concurrentOpenProjectId);
assert.equal(
  concurrentOpen.filter((job) => job.operationId.startsWith('concurrent-open-')).length,
  96,
  'serialized concurrent writes must retain every open row even above the history cap',
);
assert.equal(
  concurrentOpen.filter((job) => job.operationId.startsWith('concurrent-terminal-')).length,
  80,
  'concurrent open writes must still cap terminal history independently',
);

const prefixJobs = [
  { ...patched[0], operationId: 'op-aa', jobId: 'job-aa' },
  { ...patched[1], operationId: 'op-ab', jobId: 'job-ab' },
];
assert.equal(resolveTrackedJob(prefixJobs, 'op-aa').ok, true, 'exact operation id wins before prefix matching');
const ambiguous = resolveTrackedJob(prefixJobs, 'op-a');
assert.equal(ambiguous.ok, false);
if (!ambiguous.ok) {
  assert.equal(ambiguous.code, 'ambiguous');
  assert.deepEqual(ambiguous.candidates?.map((candidate) => candidate.distinguishingId), ['op-aa', 'op-ab']);
}

await registerTrackedJob({
  operationId: 'legacy-summary-only',
  jobId: 'legacy-summary-only',
  projectId,
  status: 'failed',
  params: { prompt: 'not a complete request' },
});
const context = {
  getProjectId: () => projectId,
  getState: () => ({}) as never,
  getDoc: () => ({}) as never,
  getCreativeMode: () => null,
  commands: {} as never,
  templates: [],
  audio: [],
} as AgentContext;
const legacyResult = await executeGenerateCommand('rerun_generation', { jobId: 'legacy-summary-only' }, context) as { code?: string };
assert.equal(legacyResult.code, 'legacy_summary', 'summary-only legacy rows must never be guessed into a provider request');

await registerTrackedJob({
  operationId: 'preflight-in-flight',
  jobId: 'preflight-in-flight',
  projectId,
  status: 'submitting',
  toolName: 'submit_video',
  submitArgs: { model: 'kling', prompt: 'materializing source slice' },
});
await applyGenerationJobReports(projectId, [{
  operationId: 'preflight-in-flight',
  jobId: 'preflight-in-flight',
  status: 'not_found',
  error: 'generation job not found',
}]);
const provisional = (await listTrackedJobs(projectId)).find((job) => job.operationId === 'preflight-in-flight');
assert.equal(provisional?.status, 'submitting', 'a refresh race must not terminally discard an awaited submit intent');

const ingestionProjectId = 'project:job-registry-ingestion-verify';
await registerTrackedJob({
  operationId: 'multi-result-ingestion',
  jobId: 'multi-result-ingestion',
  projectId: ingestionProjectId,
  status: 'running',
});
await applyGenerationJobReports(ingestionProjectId, [{
  operationId: 'multi-result-ingestion',
  jobId: 'multi-result-ingestion',
  status: 'succeeded',
  results: [
    {
      assetId: 'result-a',
      name: 'result-a.mp4',
      path: '/generated/result-a.mp4',
      kind: 'video',
      durationSeconds: 2,
      width: 1920,
      height: 1080,
    },
    {
      assetId: 'result-b',
      name: 'result-b.mp4',
      path: '/generated/result-b.mp4',
      kind: 'video',
      durationSeconds: 3,
      width: 1920,
      height: 1080,
    },
  ],
}]);
let pendingIngestion = await listOpenJobs(ingestionProjectId);
assert.deepEqual(
  pendingIngestion[0]?.resultAssetIds,
  ['result-a', 'result-b'],
  'a succeeded multi-result job must retain every asset identity for crash recovery',
);
const resumedAssets: Array<{ id: string; durationInFrames: number }> = [];
const fetchBeforeCachedResume = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error('durable terminal result recovery must not depend on the expired server journal');
}) as typeof fetch;
try {
  const resumed = await resumeOpenGenerationJobs(ingestionProjectId, {
    getState: () => ({ fps: 30, assets: [], items: [], transitions: [], markers: [] }) as never,
    onAsset: (asset) => { resumedAssets.push({ id: asset.id, durationInFrames: asset.durationInFrames }); },
  });
  assert.equal(resumed.completed, 1);
} finally {
  globalThis.fetch = fetchBeforeCachedResume;
}
assert.deepEqual(resumedAssets, [
  { id: 'result-a', durationInFrames: 60 },
  { id: 'result-b', durationInFrames: 90 },
], 'a crash-recovered terminal job must ingest its durable result payload without the server journal');
await acknowledgeIngestedGenerationResults(ingestionProjectId, [{ id: 'result-a' }]);
pendingIngestion = await listOpenJobs(ingestionProjectId);
assert.equal(
  pendingIngestion.length,
  1,
  'a partially saved multi-result job must remain recoverable',
);
await acknowledgeIngestedGenerationResults(ingestionProjectId, [{ id: 'result-a' }, { id: 'result-b' }]);
assert.equal(
  (await listOpenJobs(ingestionProjectId)).length,
  0,
  'a succeeded job becomes terminal only after every result asset is durably acknowledged',
);

await registerTrackedJob({
  operationId: 'guard-original-operation',
  jobId: 'guard-original-operation',
  projectId,
  status: 'failed',
  toolName: 'submit_video',
  submitArgs: { model: 'kling', durationSeconds: 5, prompt: 'Original prompt' },
});
const rerunGuard = await runtimeGuardForTool('rerun_generation', { jobId: 'guard-original' }, context);
assert.equal(rerunGuard?.tool, 'submit_video');
assert.equal(rerunGuard?.operationId, 'guard-original-operation');
assert.match(rerunGuard?.summary ?? '', /模型=kling.*Original prompt|model=kling.*Original prompt/);

console.log('job registry checks passed');
