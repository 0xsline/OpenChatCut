import assert from 'node:assert/strict';
import { createExportJobStore } from './backgroundExportStore';
import type { ExportDestination } from './exportDestination';
import {
  rebindAndResumePersistedServerExport,
  resumePersistedServerExports,
  retirePersistedServerExport,
} from './serverExportOperation';
import {
  listServerExportJobs,
  persistServerExportJob,
  resetServerExportRecoveryMemory,
  type PersistedServerExportJob,
} from './serverExportRecovery';
import { deferred, destination } from './serverExportOperation.verify-support';

async function verifyRefreshReattachesAcceptedServerExport(): Promise<void> {
  resetServerExportRecoveryMemory();
  const deleted = deferred();
  let targetWrites = 0;
  const recoveredDestination: ExportDestination = {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: async () => { targetWrites += 1; },
          close: async () => undefined,
        }),
      }),
    },
  };
  await persistServerExportJob({
    version: 1,
    renderId: 'render-before-refresh',
    projectId: 'project-refresh',
    label: 'refresh.mp4',
    targetPath: 'Exports/refresh.mp4',
    createdAt: 10,
    updatedAt: 10,
    format: 'video',
    codec: 'h264',
    base: 'refresh',
    fps: 30,
    state: { fps: 30, items: [], transitions: [], markers: [] } as never,
    destination: recoveredDestination,
    autoQaEnabled: false,
    stage: 'polling',
  });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === '/export/job/render-before-refresh' && init?.method === 'DELETE') {
      deleted.resolve();
      return new Response(null, { status: 204 });
    }
    if (url === '/export/job/render-before-refresh') {
      return Response.json({
        status: 'succeeded',
        progress: 100,
        result: { path: '/media/recovered.mp4', name: 'refresh.mp4', sizeBytes: 5 },
      });
    }
    if (url.endsWith('/media/recovered.mp4')) return new Response('video');
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const recoveredStore = createExportJobStore();
  await resumePersistedServerExports({
    exportJobs: recoveredStore,
    projectId: 'project-refresh',
    t: (key) => key,
  });
  await deleted.promise;
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const recovered = recoveredStore.getSnapshot().jobs[0];
  assert.equal(recovered?.id, 'server-export-render-before-refresh');
  assert.equal(recovered?.progress.phase, 'completed', recovered?.error ?? undefined);
  assert.equal(targetWrites, 1, 'refresh recovery must deliver the accepted server result exactly once');
  assert.deepEqual(await listServerExportJobs('project-refresh'), []);

  const committedDeleted = deferred();
  await persistServerExportJob({
    version: 1,
    renderId: 'render-committed-before-refresh',
    projectId: 'project-refresh',
    label: 'committed.mp4',
    targetPath: 'Exports/committed.mp4',
    createdAt: 20,
    updatedAt: 20,
    format: 'video',
    codec: 'h264',
    base: 'committed',
    fps: 30,
    state: { fps: 30, items: [], transitions: [], markers: [] } as never,
    destination: recoveredDestination,
    autoQaEnabled: false,

    stage: 'target-committed',
  });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === '/export/job/render-committed-before-refresh' && init?.method === 'DELETE') {
      committedDeleted.resolve();
      return new Response(null, { status: 204 });
    }
    throw new Error(`committed recovery must only clean up its server job: ${url}`);
  }) as typeof fetch;
  const committedStore = createExportJobStore();
  await resumePersistedServerExports({
    exportJobs: committedStore,
    projectId: 'project-refresh',
    t: (key) => key,
  });
  await committedDeleted.promise;
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  assert.equal(committedStore.getSnapshot().jobs[0]?.progress.phase, 'completed');
  assert.equal(targetWrites, 1, 'a target committed before refresh must never be written twice');
  assert.deepEqual(await listServerExportJobs('project-refresh'), []);
}
async function verifyRecoveredWriteFailureRetainsCompletedRender(): Promise<void> {
  resetServerExportRecoveryMemory();
  const requests: string[] = [];
  const recovery: PersistedServerExportJob = {
    version: 1,
    renderId: 'render-recovered-write-failure',
    projectId: 'project-recovered-write-failure',
    label: 'retained.mp4',
    targetPath: 'Exports/retained.mp4',
    createdAt: 25,
    updatedAt: 25,
    format: 'video',
    codec: 'h264',
    base: 'retained',
    fps: 30,
    state: { fps: 30, items: [], transitions: [], markers: [] } as never,
    destination: {
      type: 'browser-directory',
      label: 'Exports',
      handle: {
        kind: 'directory',
        name: 'Exports',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getFileHandle: async () => ({
          createWritable: async () => ({
            write: async () => { throw new Error('disk full'); },
            close: async () => undefined,
          }),
        }),
      },
    },
    autoQaEnabled: false,
    stage: 'polling',
  };
  await persistServerExportJob(recovery);
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === `/export/job/${recovery.renderId}` && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === `/export/job/${recovery.renderId}`) {
      return Response.json({
        status: 'succeeded',
        progress: 100,
        result: { path: '/media/recovered-write-failure.mp4', name: 'retained.mp4', sizeBytes: 5 },
      });
    }
    if (url === '/media/recovered-write-failure.mp4') return new Response('video');
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const store = createExportJobStore();
  await resumePersistedServerExports({
    exportJobs: store,
    projectId: recovery.projectId,
    t: (key) => key,
  });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const recovered = store.getSnapshot().jobs[0];
  assert.equal(recovered?.progress.phase, 'failed');
  assert.equal(recovered?.failure?.stage, 'destination');
  assert.equal(requests.some((request) => request === `DELETE /export/job/${recovery.renderId}`), false,
    'recovered write failure must retain the completed server output');
  const retained = await listServerExportJobs(recovery.projectId);
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.stage, 'output-ready');
  resetServerExportRecoveryMemory();
}
async function verifyMissingBrowserAuthorityRetainsCompletedRender(): Promise<void> {
  resetServerExportRecoveryMemory();
  const retained: PersistedServerExportJob = {
    version: 1,
    renderId: 'render-missing-browser-authority',
    projectId: 'project-missing-authority',
    label: 'retained.mp4',
    targetPath: 'Exports/retained.mp4',
    createdAt: 30,
    updatedAt: 30,
    format: 'video',
    codec: 'h264',
    base: 'retained',
    fps: 30,
    state: { fps: 30, items: [], transitions: [], markers: [] } as never,
    destination: {
      type: 'browser-directory',
      label: 'Exports',
      handle: null,
    },
    autoQaEnabled: false,
    stage: 'polling',
  };
  await persistServerExportJob(retained);
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    throw new Error('missing authority recovery must not touch the completed render');
  }) as typeof fetch;
  const recoveredStore = createExportJobStore();
  await resumePersistedServerExports({
    exportJobs: recoveredStore,
    projectId: retained.projectId,
    t: (key) => key,
  });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const recovered = recoveredStore.getSnapshot().jobs[0];
  assert.equal(recovered?.progress.phase, 'failed');
  assert.equal(recovered?.failure?.stage, 'destination');
  assert.equal(recovered?.failure?.retryable, true);
  assert.match(recovered?.error ?? '', /重新选择导出位置/);
  assert.deepEqual(requests, [], 'missing handle authority must retain the completed render');
  assert.deepEqual(await listServerExportJobs(retained.projectId), [retained],
    'missing handle authority must retain the recovery stage for reselection');

  resetServerExportRecoveryMemory();
  const stale: PersistedServerExportJob = {
    ...retained,
    renderId: 'render-stale-browser-authority',
    projectId: 'project-stale-authority',
    destination: {
      type: 'browser-file',
      label: 'retained.mp4',
      handle: {
        kind: 'file',
        name: 'retained.mp4',
        createWritable: async () => { throw new Error('stale handle'); },
        queryPermission: async () => { throw new Error('stale handle'); },
        requestPermission: async () => { throw new Error('stale handle'); },
      },
    },
  };
  await persistServerExportJob(stale);
  const staleStore = createExportJobStore();
  await resumePersistedServerExports({
    exportJobs: staleStore,
    projectId: stale.projectId,
    t: (key) => key,
  });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const staleRecovery = staleStore.getSnapshot().jobs[0];
  assert.equal(staleRecovery?.progress.phase, 'failed');
  assert.match(staleRecovery?.error ?? '', /重新选择导出位置/);
  assert.deepEqual(requests, [], 'stale handle authority must retain the completed render');
  assert.deepEqual(await listServerExportJobs(stale.projectId), [stale],
    'stale handle authority must retain the recovery stage for reselection');
}


async function verifyRebindResumesCompletedOutputWithoutRender(): Promise<void> {
  resetServerExportRecoveryMemory();
  const retained: PersistedServerExportJob = {
    version: 1, renderId: 'render-rebound', projectId: 'project-rebound',
    label: 'rebound.mp4', targetPath: 'Lost/rebound.mp4', createdAt: 40, updatedAt: 40,
    format: 'video', codec: 'h264', base: 'rebound', fps: 30,
    state: { fps: 30, items: [], transitions: [], markers: [] } as never,
    destination: { type: 'browser-file', label: 'rebound.mp4', handle: null },
    autoQaEnabled: false, stage: 'output-ready',
  };
  await persistServerExportJob(retained);
  let renders = 0;
  let writes = 0;
  const deleted = deferred();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === '/export/job' && init?.method === 'POST') { renders += 1; return Response.json({}); }
    if (url === '/export/job/render-rebound' && init?.method === 'DELETE') {
      deleted.resolve(); return new Response(null, { status: 204 });
    }
    if (url === '/export/job/render-rebound') return Response.json({
      status: 'succeeded', progress: 100,
      result: { path: '/media/rebound.mp4', name: 'rebound.mp4', sizeBytes: 5 },
    });
    if (url.endsWith('/media/rebound.mp4')) return new Response('video');
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const store = createExportJobStore();
  const selected: ExportDestination = {
    type: 'browser-file', label: 'rebound.mp4',
    handle: {
      kind: 'file', name: 'rebound.mp4',
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => ({
        write: async () => { writes += 1; }, close: async () => undefined,
      }),
    },
  };
  await rebindAndResumePersistedServerExport({
    destination: selected, exportJobs: store, renderId: retained.renderId,
    t: (key) => key, targetPath: 'rebound.mp4',
  });
  await Promise.race([
    deleted.promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => {
      reject(new Error(`rebound delivery did not settle: ${JSON.stringify(store.getSnapshot())}`));
    }, 2_000)),
  ]);
  assert.equal(renders, 0, 'rebind must never submit a replacement render');
  assert.equal(writes, 1, 'rebind delivers the retained completed output once');
}

async function verifyExplicitRerenderRetiresRecoveryFirst(): Promise<void> {
  resetServerExportRecoveryMemory();
  const retained: PersistedServerExportJob = {
    version: 1, renderId: 'render-retired', projectId: 'project-retired',
    label: 'retired.mp4', targetPath: null, createdAt: 50, updatedAt: 50,
    format: 'video', codec: 'h264', base: 'retired', fps: 30,
    state: { fps: 30, items: [], transitions: [], markers: [] } as never,
    destination, autoQaEnabled: false, stage: 'output-ready',
  };
  await persistServerExportJob(retained);
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), '/export/job/render-retired');
    assert.equal(init?.method, 'DELETE');
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  assert.equal(await retirePersistedServerExport(retained.renderId), true);
  assert.deepEqual(await listServerExportJobs(retained.projectId), []);
  const store = createExportJobStore();
  await resumePersistedServerExports({ exportJobs: store, projectId: retained.projectId, t: (key) => key });
  assert.equal(store.getSnapshot().jobs.length, 0, 'retired recovery cannot auto-deliver later');
}

export async function runServerExportRecoveryVerifications(): Promise<void> {
  await verifyRefreshReattachesAcceptedServerExport();
  await verifyRecoveredWriteFailureRetainsCompletedRender();
  await verifyMissingBrowserAuthorityRetainsCompletedRender();
  await verifyRebindResumesCompletedOutputWithoutRender();
  await verifyExplicitRerenderRetiresRecoveryFirst();
}
