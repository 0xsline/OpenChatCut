import {
  cleanupGenerationJobsFixture,
  setupGenerationJobsFixture,
} from './generation-jobs.verify-fixtures.ts';
import {
  verifyExportJobResultNames,
  verifyFailedAndResumableGenerationJobs,
  verifyMurekaAudioUrls,
  verifyRestoredGenerationJobs,
  verifySuccessfulGenerationJobs,
  verifyTaskLimitedGenerationJobs,
} from './generation-jobs.verify-groups.ts';

const fixture = await setupGenerationJobsFixture();

// This verify controls the persisted store before intentionally crossing the module-load boundary.
const generationJobs = await import('./generation-jobs.ts');
const exportRuntime = await import('./export-runtime.ts');
const music = await import('./music.ts');

verifyExportJobResultNames(fixture, exportRuntime);
await verifyRestoredGenerationJobs(fixture, generationJobs, exportRuntime);
await verifySuccessfulGenerationJobs(fixture, generationJobs, exportRuntime);
await verifyFailedAndResumableGenerationJobs(fixture, generationJobs);
await verifyTaskLimitedGenerationJobs(generationJobs);
verifyMurekaAudioUrls(music);

await cleanupGenerationJobsFixture(fixture);

console.log('generation checks passed');
