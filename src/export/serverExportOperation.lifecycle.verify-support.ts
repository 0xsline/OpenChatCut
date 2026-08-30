import assert from 'node:assert/strict';
import { clearExportHistory, listExportHistory } from '../persist/exportHistoryStore';
import { createExportJobStore } from './backgroundExportStore';
import type { ExportDestination } from './exportDestination';
import { ExportFailureError } from './exportFailure';
import { createExportRunner } from './exportRunOperation';
import { createServerExporter, isServerRenderError } from './serverExportOperation';
import { pollExport, type ServerExportContext } from './serverExportRenderOperation';
import { listServerExportJobs, resetServerExportRecoveryMemory } from './serverExportRecovery';
import type { ExportJobResult, ExportProgress, UseExportWorkflowOptions, WorkflowOperations } from './exportWorkflowTypes';
import { deferred, exporter, noop, type Deferred } from './serverExportOperation.verify-support';

async function verifyRenderFailureIsTypedAndDeleted(): Promise<void> {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/export/job') {
      const body = JSON.parse(String(init?.body)) as { operationId?: string };
      assert.equal(body.operationId, 'render-failed');
      assert.ok(
        (await listServerExportJobs('project-lifecycle'))
          .some((record) => record.renderId === body.operationId),
        'recovery must be durable before the server accepts the render job',
      );
      return Response.json({ renderId: 'render-failed' });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({
      status: 'failed',
      progress: 100,
      error: 'renderer failed',
      failure: {
        stage: 'render',
        code: 'export_render_failed',
        retryable: true,
        cleanupStatus: 'succeeded',
        targetPath: '/media/uploads/render-failed.mp4',
        message: 'renderer failed',
      },
    });
  }) as typeof fetch;
  await assert.rejects(
    exporter()('video'),
    (error) => isServerRenderError(error)
      && error.message === 'renderer failed'
      && error.failure?.stage === 'render'
      && error.failure.cleanupStatus === 'succeeded',
  );
  assert.deepEqual(requests, [
    'POST /export/job',
    'GET /export/job/render-failed',
    'DELETE /export/job/render-failed',
  ]);
}

async function verifyDeliveryFailureDoesNotTriggerRenderFallback(): Promise<void> {
  resetServerExportRecoveryMemory();
  const requests: string[] = [];
  const browserDestination: ExportDestination = {
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
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/export/job') return Response.json({ renderId: 'render-succeeded' });
    if (url === '/export/job/render-succeeded' && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === '/export/job/render-succeeded') {
      return Response.json({
        status: 'succeeded',
        progress: 1,
        result: { path: '/media/output.mp4', name: 'output.mp4', sizeBytes: 5 },
      });
    }
    if (url.endsWith('/media/output.mp4')) return new Response('video');
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  await assert.rejects(
    exporter(browserDestination)('video'),
    (error) => error instanceof ExportFailureError
      && error.failure.stage === 'destination'
      && error.failure.code === 'export_destination_write_failed'
      && error.failure.targetPath === 'Exports/output.mp4',
  );
  assert.equal(requests.some((request) => request === 'DELETE /export/job/render-succeeded'), false,
    'a write failure after completed polling must retain the server output');
  const retained = await listServerExportJobs('project-lifecycle');
  assert.equal(retained.length, 1);
  assert.equal(retained[0]?.renderId, 'render-succeeded');
  assert.equal(retained[0]?.stage, 'output-ready');
  resetServerExportRecoveryMemory();
}

async function verifyPollFailureDoesNotTriggerRenderFallback(): Promise<void> {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/export/job') return Response.json({ renderId: 'render-active' });
    if (init?.method === 'DELETE') return Response.json({ error: 'still running' }, { status: 409 });
    return Response.json({ error: 'temporary poll failure' }, { status: 503 });
  }) as typeof fetch;
  await assert.rejects(
    exporter()('video'),
    (error) => error instanceof Error
      && error.name !== 'ServerRenderError'
      && error.message === 'temporary poll failure',
  );
  assert.equal(requests.at(-1), 'DELETE /export/job/render-active');
}

async function verifyCancellationDeletesActiveJob(): Promise<void> {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/export/job') return Response.json({ renderId: 'render-cancelled' });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ status: 'running', progress: 20, phase: 'rendering' });
  }) as typeof fetch;
  const controller = new AbortController();
  const operation = exporter()('video', controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(operation, (error) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(requests.at(-1), 'DELETE /export/job/render-cancelled');
}

async function verifyQueuedProgressExplainsTheWait(): Promise<void> {
  for (const phases of [['queued', 'rendering', 'finalizing', 'succeeded'], ['queued', 'succeeded'], ['rendering', 'succeeded']]) {
    let polls = 0;
    let progress: ExportProgress | null = {
      phase: 'preparing', percent: 0, startedAt: Date.now(), detail: 'Hardware encoder detected',
    };
    const seen: Array<ExportProgress | null> = [];
    globalThis.fetch = (async () => {
      const phase = phases[polls++];
      return Response.json(phase === 'succeeded' ? {
        status: 'succeeded', progress: 100,
        result: { path: '/media/output.mp4', name: 'output.mp4', sizeBytes: 5 },
      } : { status: phase === 'queued' ? 'queued' : 'running', progress: 10 * polls, phase });
    }) as typeof fetch;
    await pollExport({
      setProgress: (update) => {
        progress = typeof update === 'function' ? update(progress) : update;
        seen.push(progress);
      },
      t: (key) => key,
    } as ServerExportContext, 'render-queued');
    assert.equal(seen.length, phases.length);
    if (phases[0] === 'queued') {
      assert.equal(seen[0]?.detail, '已有其他导出任务正在运行，当前任务将在其完成后自动开始');
      assert.ok(seen.slice(1).every((entry) => entry?.detail === undefined), 'queue hint clears when rendering or completion starts');
    } else {
      assert.ok(seen.every((entry) => entry?.detail === 'Hardware encoder detected'), 'nonqueued detail is unchanged');
    }
  }
}

interface BackgroundServerExportOptions {
  autoQaEnabled?: boolean;
  operationId?: string;
  verifyCompletedExport?: (completed: ExportJobResult, signal?: AbortSignal) => Promise<void>;
}

function startBackgroundServerExport(
  destination: ExportDestination,
  done: Deferred,
  testOptions: BackgroundServerExportOptions = {},
) {
  const store = createExportJobStore();
  const options: UseExportWorkflowOptions = {
    state: { items: [] } as never,
    projectId: 'project-lifecycle',
    projectName: 'Lifecycle',
    base: 'lifecycle',
    tab: 'video',
    codec: 'h264',
    resolution: '1080p',
    fps: 30,
    subtitleFormat: 'srt',
    subtitleCaptions: null,
    nleFormat: 'fcp_xml',
    includeMg: false,
    mgItems: [],
    onClose: noop,
  };
  const id = store.start({
    label: 'lifecycle.mp4',
    targetPath: 'Exports/lifecycle.mp4',
    async execute({ signal, setters }) {
      const exportServer = createServerExporter({
        ...(testOptions.operationId
          ? { createOperationId: () => testOptions.operationId as string }
          : {}),
        autoQaEnabled: testOptions.autoQaEnabled ?? false,
        destination,
        options,
        beginTargetCommit: setters.beginTargetCommit,
        endTargetCommit: setters.endTargetCommit,
        markTargetCommitted: setters.markTargetCommitted,
        setBusy: setters.setBusy,
        setEngineInfo: setters.setEngineInfo,
        setEngineReason: setters.setEngineReason,
        setProgress: setters.setProgress,
        setRenderEngine: setters.setRenderEngine,
        t: (key) => key,
        verifyCompletedExport: testOptions.verifyCompletedExport ?? (async () => undefined),
      });
      const idle = async () => undefined;
      const committed = Object.freeze({ targetCommitted: true as const });
      const operations: WorkflowOperations = {
        exportAudio: async (signal) => { await exportServer('audio', signal); return committed; },
        exportMg: idle,
        exportSubtitles: idle,
        exportVideo: async (signal) => { await exportServer('video', signal); return committed; },
        exportXml: idle,
      };
      const run = createExportRunner({
        busy: null,
        operations,
        options,
        prepareDestination: async () => undefined,
        progress: null,
        signal,
        targetPath: 'Exports/lifecycle.mp4',
        t: (key) => key,
        ...setters,
      });
      try {
        await run();
      } finally {
        done.resolve();
      }
    },
  });
  return { id, store };
}

async function verifyCancellationAfterRenderDoesNotSave(): Promise<void> {
  await clearExportHistory();
  const permissionStarted = deferred();
  const permissionGate = deferred();
  const done = deferred();
  let targetFiles = 0;
  let targetWrites = 0;
  const browserDestination: ExportDestination = {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission: async () => {
        permissionStarted.resolve();
        await permissionGate.promise;
        return 'granted';
      },
      requestPermission: async () => 'granted',
      getFileHandle: async () => {
        targetFiles += 1;
        return {
          createWritable: async () => ({
            write: async () => { targetWrites += 1; },
            close: async () => undefined,
          }),
        };
      },
    },
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === '/export/job') return Response.json({ renderId: 'render-save-cancelled' });
    if (url === '/export/job/render-save-cancelled' && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === '/export/job/render-save-cancelled') {
      return Response.json({
        status: 'succeeded',
        progress: 1,
        result: { path: '/media/output.mp4', name: 'output.mp4', sizeBytes: 5 },
      });
    }
    if (url.endsWith('/media/output.mp4')) return new Response('video');
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { id, store } = startBackgroundServerExport(browserDestination, done, {
    operationId: 'render-save-cancelled',
  });
  await permissionStarted.promise;
  const saving = store.getSnapshot().jobs.find((job) => job.id === id);
  assert.equal(saving?.progress.phase, 'downloading');
  assert.equal(saving?.busy, '正在保存…');
  assert.equal(store.cancel(id), true);
  permissionGate.resolve();
  await done.promise;
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const cancelled = store.getSnapshot().jobs.find((job) => job.id === id);
  assert.equal(targetFiles, 0, 'cancelling while saving must not create the target file');
  assert.equal(targetWrites, 0);
  assert.equal(cancelled?.progress.phase, 'cancelled');
  assert.notEqual(cancelled?.progress.phase, 'completed');
  assert.equal((await listExportHistory()).length, 0, 'cancelled delivery must not record an export');
}

async function verifyCancellationDuringServerQaDoesNotSave(): Promise<void> {
  await clearExportHistory();
  const qaStarted = deferred();
  const qaGate = deferred();
  const done = deferred();
  let qaSignal: AbortSignal | undefined;
  let targetFiles = 0;
  let sourceReads = 0;
  const browserDestination: ExportDestination = {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async () => {
        targetFiles += 1;
        return {
          createWritable: async () => ({
            write: async () => undefined,
            close: async () => undefined,
          }),
        };
      },
    },
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === '/export/job') return Response.json({ renderId: 'render-qa-cancelled' });
    if (url === '/export/job/render-qa-cancelled' && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (url === '/export/job/render-qa-cancelled') {
      return Response.json({
        status: 'succeeded',
        progress: 1,
        result: { path: '/media/output.mp4', name: 'output.mp4', sizeBytes: 5 },
      });
    }
    if (url.endsWith('/media/output.mp4')) {
      sourceReads += 1;
      return new Response('video');
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { id, store } = startBackgroundServerExport(browserDestination, done, {
    autoQaEnabled: true,
    operationId: 'render-qa-cancelled',
    verifyCompletedExport: async (_completed, signal) => {
      qaSignal = signal;
      qaStarted.resolve();
      await qaGate.promise;
    },
  });
  await qaStarted.promise;
  assert.equal(store.cancel(id), true);
  qaGate.resolve();
  await done.promise;
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const cancelled = store.getSnapshot().jobs.find((job) => job.id === id);
  assert.equal(qaSignal?.aborted, true);
  assert.equal(sourceReads, 0, 'cancelled QA never starts destination source delivery');
  assert.equal(targetFiles, 0);
  assert.equal(cancelled?.progress.phase, 'cancelled');
  assert.equal((await listExportHistory()).length, 0);
}

async function verifyNormalServerSaveStillCompletes(): Promise<void> {
  await clearExportHistory();
  const done = deferred();
  const deleteStarted = deferred();
  const deleteGate = deferred();
  const closeStarted = deferred();
  const closeGate = deferred();
  let targetFiles = 0;
  let targetWrites = 0;
  let writerAborts = 0;
  const browserDestination: ExportDestination = {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async () => {
        targetFiles += 1;
        return {
          createWritable: async () => ({
            write: async () => { targetWrites += 1; },
            close: async () => {
              closeStarted.resolve();
              await closeGate.promise;
            },
            abort: async () => { writerAborts += 1; },
          }),
        };
      },
    },
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === '/export/job') return Response.json({ renderId: 'render-save-completed' });
    if (url === '/export/job/render-save-completed' && init?.method === 'DELETE') {
      deleteStarted.resolve();
      await deleteGate.promise;
      return new Response(null, { status: 204 });
    }
    if (url === '/export/job/render-save-completed') {
      return Response.json({
        status: 'succeeded',
        progress: 1,
        result: { path: '/media/output.mp4', name: 'output.mp4', sizeBytes: 5 },
      });
    }
    if (url.endsWith('/media/output.mp4')) return new Response('video');
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const { id, store } = startBackgroundServerExport(browserDestination, done, {
    operationId: 'render-save-completed',
  });
  await Promise.race([
    closeStarted.promise,
    done.promise.then(() => {
      throw new Error(`export ended before target commit: ${JSON.stringify(store.getSnapshot())}`);
    }),
  ]);
  assert.equal(store.cancel(id), true, 'cancellation is requested while target commit is in progress');
  closeGate.resolve();
  await deleteStarted.promise;
  assert.equal(store.cancel(id), false, 'a committed target cannot be cancelled during job cleanup');
  deleteGate.resolve();
  await done.promise;
  const historyTick = deferred();
  setTimeout(() => { historyTick.resolve(); }, 0);
  await historyTick.promise;
  const completedJob = store.getSnapshot().jobs.find((job) => job.id === id);
  assert.equal(targetFiles, 1);
  assert.equal(targetWrites, 1);
  assert.equal(writerAborts, 1);
  assert.equal(completedJob?.progress.phase, 'completed');
  assert.equal((await listExportHistory()).some((entry) => entry.name === 'output.mp4'), true);
}

export async function runServerExportLifecycleVerifications(): Promise<void> {
  await verifyRenderFailureIsTypedAndDeleted();
  await verifyDeliveryFailureDoesNotTriggerRenderFallback();
  await verifyPollFailureDoesNotTriggerRenderFallback();
  await verifyCancellationDeletesActiveJob();
  await verifyQueuedProgressExplainsTheWait();
  await verifyCancellationAfterRenderDoesNotSave();
  await verifyCancellationDuringServerQaDoesNotSave();
  await verifyNormalServerSaveStillCompletes();
}
