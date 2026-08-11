import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface GenerationJobsFixture {
  acceptedAt: number;
  deleteAssetId: string;
  deleteExportName: string;
  expiryAssetId: string;
  expiryExportName: string;
  malformedAssetId: string;
  previousStorePath: string | undefined;
  providerMediaName: string;
  storePath: string;
  storeRoot: string;
  uploadRoot: string;
  userMediaName: string;
}

export async function waitFor(
  check: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function setupGenerationJobsFixture(): Promise<GenerationJobsFixture> {
  const storeRoot = await mkdtemp(join(tmpdir(), 'openchatcut-generation-jobs-'));
  const storePath = join(storeRoot, 'operations.json');
  const previousStorePath = process.env.OPENCHATCUT_GENERATION_JOB_STORE;
  process.env.OPENCHATCUT_GENERATION_JOB_STORE = storePath;
  const restoredAt = Date.now() - 1_000;
  const acceptedAt = restoredAt + 100;
  const uploadRoot = join(storeRoot, 'uploads');
  await mkdir(uploadRoot);
  const deleteAssetId = '11111111-1111-4111-8111-111111111111';
  const expiryAssetId = '22222222-2222-4222-8222-222222222222';
  const malformedAssetId = '33333333-3333-4333-8333-333333333333';
  const deleteExportName = `openchatcut-export-job-${deleteAssetId}.mp4`;
  const expiryExportName = `openchatcut-export-job-${expiryAssetId}.mp4`;
  const userMediaName = 'user-media.mp4';
  const providerMediaName = 'provider-output.mp4';
  for (const name of [deleteExportName, expiryExportName, userMediaName, providerMediaName]) {
    await writeFile(join(uploadRoot, name), name, 'utf8');
  }
  await writeFile(storePath, JSON.stringify({
    version: 1,
    jobs: [
      {
        id: 'restored-queued-unknown',
        operationId: 'restored-queued-unknown',
        status: 'queued',
        progress: 0,
        phase: 'queued',
        params: { kind: 'video', model: 'seedance2' },
        submitArgs: { model: 'seedance2', prompt: 'explicit rerun remains available' },
        toolName: 'submit_video',
        provider: 'seedance2',
        retryClass: 'none',
        timestamps: { createdAt: restoredAt, submittedAt: restoredAt, updatedAt: restoredAt },
        createdAt: restoredAt,
        updatedAt: restoredAt,
      },
      {
        id: 'restored-running-export',
        operationId: 'restored-running-export',
        status: 'running',
        progress: 37,
        phase: 'rendering',
        params: { kind: 'export' },
        retryClass: 'none',
        timestamps: {
          createdAt: restoredAt,
          submittedAt: restoredAt,
          startedAt: restoredAt + 10,
          updatedAt: restoredAt + 10,
        },
        createdAt: restoredAt,
        updatedAt: restoredAt + 10,
      },
      {
        id: 'restored-accepted-download',
        operationId: 'restored-accepted-download',
        status: 'running',
        progress: 86,
        phase: 'downloading',
        params: { kind: 'video', model: 'seedance2' },
        toolName: 'submit_video',
        provider: 'seedance2',
        resultUrls: ['https://cdn.example/restored.mp4'],
        retryClass: 'download-retryable',
        timestamps: {
          createdAt: restoredAt,
          submittedAt: restoredAt,
          acceptedAt,
          startedAt: restoredAt + 10,
          updatedAt: restoredAt + 20,
        },
        createdAt: restoredAt,
        updatedAt: restoredAt + 20,
      },
      {
        id: 'restored-export-delete',
        operationId: 'restored-export-delete',
        status: 'succeeded',
        progress: 100,
        phase: 'completed',
        params: { kind: 'export' },
        retryClass: 'none',
        cleanupPolicy: 'server-export',
        timestamps: {
          createdAt: restoredAt,
          submittedAt: restoredAt,
          acceptedAt: restoredAt + 10,
          startedAt: restoredAt + 10,
          succeededAt: restoredAt + 20,
          updatedAt: restoredAt + 20,
        },
        createdAt: restoredAt,
        updatedAt: restoredAt + 20,
        result: {
          assetId: deleteAssetId,
          kind: 'video',
          name: 'restored export delete',
          path: `/media/uploads/${deleteExportName}`,
          durationSeconds: 1,
        },
        results: [{
          assetId: deleteAssetId,
          kind: 'video',
          name: 'restored export delete',
          path: `/media/uploads/${deleteExportName}`,
          durationSeconds: 1,
        }],
      },
      {
        id: 'restored-export-expiry',
        operationId: 'restored-export-expiry',
        status: 'succeeded',
        progress: 100,
        phase: 'completed',
        params: { kind: 'export' },
        retryClass: 'none',
        cleanupPolicy: 'server-export',
        timestamps: {
          createdAt: restoredAt - 2 * 60 * 60_000,
          submittedAt: restoredAt - 2 * 60 * 60_000,
          acceptedAt: restoredAt - 2 * 60 * 60_000,
          startedAt: restoredAt - 2 * 60 * 60_000,
          succeededAt: restoredAt - 2 * 60 * 60_000,
          updatedAt: restoredAt - 2 * 60 * 60_000,
        },
        createdAt: restoredAt - 2 * 60 * 60_000,
        updatedAt: restoredAt - 2 * 60 * 60_000,
        result: {
          assetId: expiryAssetId,
          kind: 'video',
          name: 'restored export expiry',
          path: `/media/uploads/${expiryExportName}`,
          durationSeconds: 1,
        },
        results: [{
          assetId: expiryAssetId,
          kind: 'video',
          name: 'restored export expiry',
          path: `/media/uploads/${expiryExportName}`,
          durationSeconds: 1,
        }],
      },
      {
        id: 'restored-export-unknown-policy',
        operationId: 'restored-export-unknown-policy',
        status: 'succeeded',
        progress: 100,
        phase: 'completed',
        params: { kind: 'export' },
        retryClass: 'none',
        cleanupPolicy: 'unregistered-future-policy',
        timestamps: {
          createdAt: restoredAt,
          submittedAt: restoredAt,
          acceptedAt: restoredAt + 10,
          startedAt: restoredAt + 10,
          succeededAt: restoredAt + 20,
          updatedAt: restoredAt + 20,
        },
        createdAt: restoredAt,
        updatedAt: restoredAt + 20,
        result: {
          assetId: malformedAssetId,
          kind: 'video',
          name: 'unknown cleanup policy',
          path: '/media/uploads/../../user-media.mp4',
          durationSeconds: 1,
        },
        results: [{
          assetId: malformedAssetId,
          kind: 'video',
          name: 'unknown cleanup policy',
          path: '/media/uploads/../../user-media.mp4',
          durationSeconds: 1,
        }],
      },
      {
        id: 'restored-export-malformed-result',
        operationId: 'restored-export-malformed-result',
        status: 'succeeded',
        progress: 100,
        phase: 'completed',
        params: { kind: 'export' },
        retryClass: 'none',
        cleanupPolicy: 'server-export',
        timestamps: {
          createdAt: restoredAt,
          submittedAt: restoredAt,
          acceptedAt: restoredAt + 10,
          startedAt: restoredAt + 10,
          succeededAt: restoredAt + 20,
          updatedAt: restoredAt + 20,
        },
        createdAt: restoredAt,
        updatedAt: restoredAt + 20,
        result: {
          assetId: malformedAssetId,
          kind: 'video',
          name: 'malformed export path',
          path: `/media/uploads/${userMediaName}`,
          durationSeconds: 1,
        },
        results: [{
          assetId: malformedAssetId,
          kind: 'video',
          name: 'malformed export path',
          path: `/media/uploads/${userMediaName}`,
          durationSeconds: 1,
        }],
      },
      {
        id: 'restored-provider-result',
        operationId: 'restored-provider-result',
        status: 'succeeded',
        progress: 100,
        phase: 'completed',
        params: { kind: 'video', model: 'seedance2' },
        retryClass: 'none',
        timestamps: {
          createdAt: restoredAt,
          submittedAt: restoredAt,
          acceptedAt: restoredAt + 10,
          startedAt: restoredAt + 10,
          succeededAt: restoredAt + 20,
          updatedAt: restoredAt + 20,
        },
        createdAt: restoredAt,
        updatedAt: restoredAt + 20,
        result: {
          assetId: 'provider-result',
          kind: 'video',
          name: 'provider result',
          path: `/media/uploads/${providerMediaName}`,
          durationSeconds: 1,
        },
        results: [{
          assetId: 'provider-result',
          kind: 'video',
          name: 'provider result',
          path: `/media/uploads/${providerMediaName}`,
          durationSeconds: 1,
        }],
      },
    ],
  }), 'utf8');

  return {
    acceptedAt,
    deleteAssetId,
    deleteExportName,
    expiryAssetId,
    expiryExportName,
    malformedAssetId,
    previousStorePath,
    providerMediaName,
    storePath,
    storeRoot,
    uploadRoot,
    userMediaName,
  };
}

export async function cleanupGenerationJobsFixture(fixture: GenerationJobsFixture): Promise<void> {
  if (fixture.previousStorePath === undefined) delete process.env.OPENCHATCUT_GENERATION_JOB_STORE;
  else process.env.OPENCHATCUT_GENERATION_JOB_STORE = fixture.previousStorePath;
  await rm(fixture.storeRoot, { recursive: true, force: true });
}
