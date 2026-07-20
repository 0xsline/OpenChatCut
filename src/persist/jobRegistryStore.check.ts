// `npx tsx src/persist/jobRegistryStore.check.ts`
import assert from 'node:assert';
import { isTerminal } from '../agent/progress/job-model';
import {
  listOpenJobs,
  listTrackedJobs,
  patchTrackedJob,
  registerTrackedJob,
  resetJobRegistryMemory,
} from './jobRegistryStore';

resetJobRegistryMemory();
const pid = 'proj_jobs_test';

const a = await registerTrackedJob({
  jobId: 'job-1',
  projectId: pid,
  label: 'music bed',
  status: 'queued',
  params: { tool: 'submit_music' },
});
assert.strictEqual(a.jobId, 'job-1');
assert.strictEqual((await listTrackedJobs(pid)).length, 1);
assert.strictEqual((await listOpenJobs(pid)).length, 1);

await registerTrackedJob({
  jobId: 'job-1',
  projectId: pid,
  status: 'running',
  label: 'music bed v2',
});
const list = await listTrackedJobs(pid);
assert.strictEqual(list.length, 1, 'register is upsert by jobId');
assert.strictEqual(list[0].status, 'running');
assert.strictEqual(list[0].label, 'music bed v2');

await patchTrackedJob(pid, 'job-1', { status: 'succeeded', resultPath: '/media/uploads/x.mp3', resultAssetId: 'asset_x' });
assert.strictEqual((await listOpenJobs(pid)).length, 0, 'succeeded is terminal');
assert.ok(isTerminal('succeeded'));

await registerTrackedJob({ jobId: 'job-2', projectId: pid, status: 'failed' });
assert.strictEqual((await listOpenJobs(pid)).length, 0);

await registerTrackedJob({ jobId: 'job-3', projectId: pid, status: 'queued' });
assert.strictEqual((await listOpenJobs(pid)).map((j) => j.jobId).join(','), 'job-3');

console.log('jobRegistryStore.check: ok');
