import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskLimiter } from '../task-limiter.ts';
import type {
  createGenerationJob,
  deleteGenerationJob,
  getGenerationJobSnapshot,
  initializeGenerationJobs,
  registerGenerationCleanupPolicy,
  registerGenerationJobResumer,
  registerGenerationRetentionGuard,
  resumeGenerationJobDownload,
} from './generation-jobs.ts';
import type { exportJobFilename, exportJobResultName } from './export-runtime.ts';
import type { pickMurekaAudioUrl } from './music.ts';
import { ResultDownloadError } from './result-download.ts';
import {
  fileExists,
  type GenerationJobsFixture,
  waitFor,
} from './generation-jobs.verify-fixtures.ts';

interface GenerationJobsApi {
  createGenerationJob: typeof createGenerationJob;
  deleteGenerationJob: typeof deleteGenerationJob;
  getGenerationJobSnapshot: typeof getGenerationJobSnapshot;
  initializeGenerationJobs: typeof initializeGenerationJobs;
  registerGenerationCleanupPolicy: typeof registerGenerationCleanupPolicy;
  registerGenerationJobResumer: typeof registerGenerationJobResumer;
  registerGenerationRetentionGuard: typeof registerGenerationRetentionGuard;
  resumeGenerationJobDownload: typeof resumeGenerationJobDownload;
}

interface ExportRuntimeApi {
  exportJobFilename: typeof exportJobFilename;
  exportJobResultName: typeof exportJobResultName;
}

interface MusicApi {
  pickMurekaAudioUrl: typeof pickMurekaAudioUrl;
}

const generationResult = (id: string) => ({
  assetId: id,
  kind: 'video' as const,
  name: id,
  path: `/media/uploads/${id}.mp4`,
  durationSeconds: 1,
});

export function verifyExportJobResultNames(
  fixture: GenerationJobsFixture,
  exportRuntime: ExportRuntimeApi,
): void {
  const {
    deleteAssetId,
    deleteExportName,
    expiryAssetId,
    malformedAssetId,
    userMediaName,
  } = fixture;
  const { exportJobResultName } = exportRuntime;

  assert.equal(
    exportJobResultName(`/media/uploads/${deleteExportName}`, deleteAssetId),
    deleteExportName,
  );
  assert.equal(exportJobResultName(`/media/uploads/${deleteExportName}?download=1`, deleteAssetId), null);
  assert.equal(exportJobResultName('/media/uploads/../user-media.mp4', deleteAssetId), null);
  assert.equal(exportJobResultName(`/media/uploads/${deleteExportName}`, expiryAssetId), null);
  assert.equal(exportJobResultName(`/media/uploads/${userMediaName}`, malformedAssetId), null);
}

export async function verifyRestoredGenerationJobs(
  fixture: GenerationJobsFixture,
  generationJobs: GenerationJobsApi,
  exportRuntime: ExportRuntimeApi,
): Promise<void> {
  const {
    acceptedAt,
    deleteAssetId,
    deleteExportName,
    expiryAssetId,
    expiryExportName,
    providerMediaName,
    storePath,
    uploadRoot,
    userMediaName,
  } = fixture;
  const {
    deleteGenerationJob,
    getGenerationJobSnapshot,
    initializeGenerationJobs,
    registerGenerationJobResumer,
    registerGenerationCleanupPolicy,
  } = generationJobs;
  const { exportJobResultName } = exportRuntime;

  const cleanupCompletedIds: string[] = [];
  registerGenerationCleanupPolicy('server-export', async (result) => {
    const name = exportJobResultName(result.path, result.assetId);
    if (!name) throw new Error(`refusing unsafe cleanup path ${result.path}`);
    await unlink(join(uploadRoot, name));
    cleanupCompletedIds.push(result.assetId);
  });

  const resumedOperationIds: string[] = [];
  registerGenerationJobResumer('submit_video', 'seedance2', async (snapshot, _update, registerDownload) => {
    resumedOperationIds.push(snapshot.operationId);
    const url = snapshot.resultUrls?.[0];
    assert.equal(url, 'https://cdn.example/restored.mp4');
    assert.ok(url);
    const download = async () => ({
      assetId: snapshot.operationId,
      kind: 'video' as const,
      name: 'restored accepted download',
      path: '/media/uploads/restored-accepted-download.mp4',
      durationSeconds: 1,
    });
    await registerDownload(url, download);
    return download();
  });

  await initializeGenerationJobs();
  await waitFor(
    () => getGenerationJobSnapshot('restored-queued-unknown')?.status === 'failed'
      && getGenerationJobSnapshot('restored-running-export')?.status === 'failed'
      && getGenerationJobSnapshot('restored-accepted-download')?.status === 'succeeded',
    'restored jobs did not leave recovering state within the recovery bound',
  );
  for (const id of ['restored-queued-unknown', 'restored-running-export']) {
    const restored = getGenerationJobSnapshot(id);
    assert.equal(restored?.status, 'failed');
    assert.equal(restored?.phase, 'failed');
    assert.equal(restored?.code, 'submission_unknown');
    assert.equal(restored?.retryable, true);
    assert.equal(restored?.retryClass, 'provider-terminal');
    assert.equal(restored?.timestamps.acceptedAt, undefined);
    assert.ok(restored?.timestamps.failedAt, `${id} must persist a terminal timestamp`);
  }
  assert.equal(getGenerationJobSnapshot('restored-queued-unknown')?.toolName, 'submit_video');
  assert.deepEqual(
    getGenerationJobSnapshot('restored-queued-unknown')?.submitArgs,
    { model: 'seedance2', prompt: 'explicit rerun remains available' },
  );
  assert.deepEqual(
    resumedOperationIds,
    ['restored-accepted-download'],
    'a registered resumer must not replay a submission whose acceptance is unknown',
  );
  const restoredDownload = getGenerationJobSnapshot('restored-accepted-download');
  assert.equal(restoredDownload?.status, 'succeeded');
  assert.equal(restoredDownload?.timestamps.acceptedAt, acceptedAt);
  assert.equal(restoredDownload?.result?.path, '/media/uploads/restored-accepted-download.mp4');
  const persistedRecovery = JSON.parse(await readFile(storePath, 'utf8')) as {
    jobs: Array<{ id: string; status: string; code?: string; retryable?: boolean }>;
  };
  for (const id of ['restored-queued-unknown', 'restored-running-export']) {
    const row = persistedRecovery.jobs.find((candidate) => candidate.id === id);
    assert.deepEqual(
      { status: row?.status, code: row?.code, retryable: row?.retryable },
      { status: 'failed', code: 'submission_unknown', retryable: true },
    );
  }
  assert.equal(getGenerationJobSnapshot('restored-export-delete')?.cleanupPolicy, 'server-export');
  await waitFor(
    () => cleanupCompletedIds.includes(expiryAssetId),
    'restored export expiry did not invoke its persisted cleanup policy',
  );
  assert.equal(getGenerationJobSnapshot('restored-export-expiry'), undefined);
  assert.equal(await fileExists(join(uploadRoot, expiryExportName)), false);

  assert.equal(await deleteGenerationJob('restored-export-delete'), true);
  assert.equal(await fileExists(join(uploadRoot, deleteExportName)), false);
  assert.ok(cleanupCompletedIds.includes(deleteAssetId));

  assert.equal(
    await deleteGenerationJob('restored-export-unknown-policy'),
    false,
    'an unknown persisted cleanup policy must preserve the journal instead of executing an arbitrary path',
  );
  assert.equal(getGenerationJobSnapshot('restored-export-unknown-policy')?.status, 'succeeded');
  assert.equal(await fileExists(join(uploadRoot, userMediaName)), true);

  assert.equal(await deleteGenerationJob('restored-export-malformed-result'), true);
  assert.equal(
    await fileExists(join(uploadRoot, userMediaName)),
    true,
    'the server-export cleanup policy must reject non-export user media paths',
  );

  assert.equal(await deleteGenerationJob('restored-provider-result'), true);
  assert.equal(
    await fileExists(join(uploadRoot, providerMediaName)),
    true,
    'provider results without an export cleanup policy must never unlink user media',
  );
}

export async function verifySuccessfulGenerationJobs(
  fixture: GenerationJobsFixture,
  generationJobs: GenerationJobsApi,
  exportRuntime: ExportRuntimeApi,
): Promise<void> {
  const { uploadRoot } = fixture;
  const {
    createGenerationJob,
    deleteGenerationJob,
    getGenerationJobSnapshot,
    registerGenerationRetentionGuard,
  } = generationJobs;
  const { exportJobFilename } = exportRuntime;

  const success = await createGenerationJob({ kind: 'music' }, async (jobId, update) => {
    await update({ phase: 'rendering', progress: 63, processedFrames: 63, totalFrames: 100 });
    const running = getGenerationJobSnapshot(jobId);
    assert.equal(running?.status, 'running');
    assert.equal(running?.phase, 'rendering');
    assert.equal(running?.progress, 63);
    assert.equal(running?.processedFrames, 63);
    assert.equal(running?.totalFrames, 100);
    return {
      assetId: jobId,
      kind: 'audio',
      name: 'check music',
      path: '/media/uploads/check.mp3',
      durationSeconds: 1,
    };
  });
  assert.equal(getGenerationJobSnapshot(success.jobId)?.status, 'queued');

  await waitFor(
    () => getGenerationJobSnapshot(success.jobId)?.status === 'succeeded',
    'successful generation did not reach succeeded',
  );
  const completed = getGenerationJobSnapshot(success.jobId);
  assert.equal(completed?.status, 'succeeded');
  assert.equal(completed?.phase, 'completed');
  assert.equal(completed?.progress, 100);
  assert.equal(completed?.processedFrames, 100);
  assert.equal(completed?.result?.assetId, success.jobId);
  assert.deepEqual(completed?.results?.map((item) => item.assetId), [success.jobId]);

  const multiple = await createGenerationJob({ kind: 'music' }, async (id) => [
    { assetId: `${id}:1`, kind: 'audio', name: 'one', path: '/one.mp3', durationSeconds: 1 },
    { assetId: `${id}:2`, kind: 'audio', name: 'two', path: '/two.mp3', durationSeconds: 1 },
  ]);
  await waitFor(
    () => getGenerationJobSnapshot(multiple.jobId)?.status === 'succeeded',
    'multi-result generation did not reach succeeded',
  );
  assert.equal(getGenerationJobSnapshot(multiple.jobId)?.result?.assetId, `${multiple.jobId}:1`);
  assert.equal(getGenerationJobSnapshot(multiple.jobId)?.results?.length, 2);

  const cleanedPaths: string[] = [];
  const removable = await createGenerationJob({ kind: 'export' }, async (id) => generationResult(id), {
    cleanupResult: async (generated) => { cleanedPaths.push(generated.path); },
  });
  await waitFor(
    () => getGenerationJobSnapshot(removable.jobId)?.status === 'succeeded',
    'removable generation did not reach succeeded',
  );
  assert.equal(await deleteGenerationJob(removable.jobId), true);
  assert.equal(getGenerationJobSnapshot(removable.jobId), undefined);
  assert.deepEqual(cleanedPaths, [`/media/uploads/${removable.jobId}.mp4`]);
  assert.equal(await deleteGenerationJob(removable.jobId), false, 'job cleanup must be idempotent');

  let unresolvedExportRecovery = true;
  registerGenerationRetentionGuard('server-export', () => unresolvedExportRecovery);
  const retainedExport = await createGenerationJob({ kind: 'export-retained' }, async (id) => {
    const name = exportJobFilename(id, 'mp4');
    await writeFile(join(uploadRoot, name), 'retained export output');
    return {
      assetId: id,
      kind: 'video' as const,
      name,
      path: `/media/uploads/${name}`,
      durationSeconds: 1,
    };
  }, {
    cleanupPolicy: 'server-export',
    retentionMs: 10,
  });
  await waitFor(
    () => getGenerationJobSnapshot(retainedExport.jobId)?.status === 'succeeded',
    'retained server export did not reach succeeded',
  );
  await delay(50);
  assert.ok(getGenerationJobSnapshot(retainedExport.jobId),
    'unresolved recovery must retain a server export beyond its expiry deadline');
  unresolvedExportRecovery = false;
  assert.equal(await deleteGenerationJob(retainedExport.jobId), true,
    'explicit retirement must permit generation journal and output cleanup');
  assert.equal(await fileExists(join(uploadRoot, exportJobFilename(retainedExport.jobId, 'mp4'))), false);

  const expiring = await createGenerationJob({ kind: 'export' }, async (id) => generationResult(id), {
    cleanupResult: async (generated) => { cleanedPaths.push(`expired:${generated.path}`); },
    retentionMs: 10,
  });
  await waitFor(
    () => getGenerationJobSnapshot(expiring.jobId) === undefined,
    'expired generation was not evicted',
  );
  assert.equal(getGenerationJobSnapshot(expiring.jobId), undefined, 'expired jobs must be evicted automatically');
  assert.ok(cleanedPaths.includes(`expired:/media/uploads/${expiring.jobId}.mp4`), 'expiry must dispose the result file');
}

export async function verifyFailedAndResumableGenerationJobs(
  fixture: GenerationJobsFixture,
  generationJobs: GenerationJobsApi,
): Promise<void> {
  const { storePath } = fixture;
  const {
    createGenerationJob,
    getGenerationJobSnapshot,
    resumeGenerationJobDownload,
  } = generationJobs;

  const failure = await createGenerationJob({ kind: 'video' }, async () => { throw new Error('expected failure'); });
  await waitFor(
    () => getGenerationJobSnapshot(failure.jobId)?.status === 'failed',
    'failed generation did not reach failed',
  );
  assert.equal(getGenerationJobSnapshot(failure.jobId)?.status, 'failed');
  assert.equal(getGenerationJobSnapshot(failure.jobId)?.phase, 'failed');
  assert.equal(getGenerationJobSnapshot(failure.jobId)?.error, 'expected failure');

  const incompleteCheckpoint = await createGenerationJob(
    { kind: 'video', returnLastFrame: true },
    async (id, _update, registerDownload) => {
      const partialDownload = async () => generationResult(id);
      await registerDownload('https://cdn.example/partial-video.mp4', partialDownload);
      await registerDownload('https://cdn.example/partial-video.mp4', partialDownload);
      return partialDownload();
    },
    { expectedResultCount: 2 },
  );
  await waitFor(
    () => getGenerationJobSnapshot(incompleteCheckpoint.jobId)?.status === 'failed',
    'an incomplete multi-result checkpoint must not succeed',
  );
  const incompleteSnapshot = getGenerationJobSnapshot(incompleteCheckpoint.jobId);
  assert.equal(incompleteSnapshot?.expectedResultCount, 2);
  assert.deepEqual(incompleteSnapshot?.resultUrls, ['https://cdn.example/partial-video.mp4']);
  assert.equal(incompleteSnapshot?.code, 'generation_result_incomplete');
  assert.equal(incompleteSnapshot?.retryable, true);
  assert.equal(incompleteSnapshot?.results, undefined);
  const persistedIncomplete = JSON.parse(await readFile(storePath, 'utf8')) as {
    jobs: Array<{ id: string; expectedResultCount?: number; resultUrls?: string[] }>;
  };
  const persistedIncompleteRow = persistedIncomplete.jobs.find((job) => job.id === incompleteCheckpoint.jobId);
  assert.equal(persistedIncompleteRow?.expectedResultCount, 2);
  assert.deepEqual(persistedIncompleteRow?.resultUrls, ['https://cdn.example/partial-video.mp4']);

  let downloadAttempts = 0;
  const resumable = await createGenerationJob({ kind: 'video' }, async (id, _update, registerDownload) => {
    const download = async () => {
      downloadAttempts += 1;
      if (downloadAttempts === 1) throw new ResultDownloadError('https://cdn.example/result.mp4', 'network');
      return generationResult(id);
    };
    await registerDownload('https://cdn.example/result.mp4', download);
    return download();
  });
  await waitFor(
    () => getGenerationJobSnapshot(resumable.jobId)?.status === 'failed',
    'download failure did not reach failed',
  );
  assert.equal(getGenerationJobSnapshot(resumable.jobId)?.pendingDownloadUrl, 'https://cdn.example/result.mp4');
  assert.equal(await resumeGenerationJobDownload(resumable.jobId), true);
  assert.equal(getGenerationJobSnapshot(resumable.jobId)?.status, 'succeeded');
  assert.equal(downloadAttempts, 2, 'resume must retry only the download callback');

  let rejectedDownloadAttempts = 0;
  const rejectedDownload = await createGenerationJob({ kind: 'video' }, async (_id, _update, registerDownload) => {
    const download = async () => {
      rejectedDownloadAttempts += 1;
      throw new ResultDownloadError('http://127.0.0.1/result.mp4', 'unsafe result URL', false);
    };
    await registerDownload('http://127.0.0.1/result.mp4', download);
    return download();
  });
  await waitFor(
    () => getGenerationJobSnapshot(rejectedDownload.jobId)?.status === 'failed',
    'terminal download rejection did not reach failed',
  );
  const rejectedDownloadSnapshot = getGenerationJobSnapshot(rejectedDownload.jobId);
  assert.equal(rejectedDownloadSnapshot?.pendingDownloadUrl, undefined);
  assert.equal(rejectedDownloadSnapshot?.retryable, false);
  assert.equal(rejectedDownloadSnapshot?.retryClass, 'provider-terminal');
  assert.equal(await resumeGenerationJobDownload(rejectedDownload.jobId), false);
  assert.equal(rejectedDownloadAttempts, 1, 'unsafe or invalid media downloads must never be resumed');
}

export async function verifyTaskLimitedGenerationJobs(
  generationJobs: GenerationJobsApi,
): Promise<void> {
  const {
    createGenerationJob,
    deleteGenerationJob,
    getGenerationJobSnapshot,
  } = generationJobs;
  const limiter = new TaskLimiter(1);
  let finishFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { finishFirst = resolve; });
  const first = await createGenerationJob({ kind: 'export' }, async (id) => {
    await firstBlocked;
    return generationResult(id);
  }, { acquire: () => limiter.acquire() });
  const second = await createGenerationJob({ kind: 'export' }, async (id) => generationResult(id), {
    acquire: () => limiter.acquire(),
  });
  await waitFor(
    () => getGenerationJobSnapshot(first.jobId)?.status === 'running'
      && getGenerationJobSnapshot(second.jobId)?.status === 'queued',
    'task limiter did not reach one running and one queued',
  );
  assert.equal(getGenerationJobSnapshot(first.jobId)?.status, 'running');
  assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'queued');
  assert.deepEqual(limiter.snapshot(), { active: 1, queued: 1, limit: 1 });
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 60_000;
  const cleanupTrigger = await createGenerationJob({ kind: 'cleanup-trigger' }, async (id) => generationResult(id));
  Date.now = realNow;
  assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'queued', 'age cleanup must retain queued jobs');
  finishFirst?.();
  await waitFor(
    () => getGenerationJobSnapshot(first.jobId)?.status === 'succeeded'
      && getGenerationJobSnapshot(second.jobId)?.status === 'succeeded'
      && getGenerationJobSnapshot(cleanupTrigger.jobId)?.status === 'succeeded',
    'limited generations and cleanup trigger did not reach succeeded',
  );
  assert.equal(getGenerationJobSnapshot(first.jobId)?.status, 'succeeded');
  assert.equal(getGenerationJobSnapshot(second.jobId)?.status, 'succeeded');
  assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, limit: 1 });
  assert.equal(
    await deleteGenerationJob(cleanupTrigger.jobId),
    true,
    'cleanup-trigger deletion flushes the final background journal write before removing the temp store',
  );
}

export function verifyMurekaAudioUrls(music: MusicApi): void {
  const { pickMurekaAudioUrl } = music;
  assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'audio' }] }), 'audio');
  assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'url' }] }), 'url');
  assert.equal(pickMurekaAudioUrl({ choices: [{ wav_url: 'wav' }] }), 'wav');
  assert.equal(pickMurekaAudioUrl({ choices: [{ flac_url: 'flac' }] }), 'flac');
}
