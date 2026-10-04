import assert from 'node:assert/strict';
import { ExportFailureError, type ExportFailure } from './exportFailure';
import { cancelRenderJob, readRenderJobSnapshot, RenderJobRequestError, submitRenderJob } from './renderJobClient';

const originalFetch = globalThis.fetch;
const failure: ExportFailure = {
  stage: 'queue', code: 'export_queue_full', retryable: true,
  cleanupStatus: 'not-required', targetPath: null, message: 'Export queue is full',
};

try {
  globalThis.fetch = async () => Response.json({ renderId: 'other-operation' });
  await assert.rejects(submitRenderJob({ operationId: 'expected-operation' }), RenderJobRequestError);
  assert.equal(await submitRenderJob({ format: 'video' }), 'other-operation');
  for (const renderId of ['', '   ', 42]) {
    globalThis.fetch = async () => Response.json({ renderId });
    await assert.rejects(submitRenderJob({}), RenderJobRequestError);
  }

  globalThis.fetch = async () => Response.json({ failure }, { status: 429 });
  for (const request of [() => submitRenderJob({}), () => readRenderJobSnapshot('job')]) {
    await assert.rejects(request, (error: unknown) => error instanceof ExportFailureError
      && error.failure.code === failure.code && error.failure.retryable);
  }

  for (const snapshot of [
    null, [], { status: 'unknown', progress: 0 },
    { status: 'running' }, { status: 'running', progress: Infinity },
    { id: 'other-job', status: 'succeeded', progress: 100 },
  ]) {
    globalThis.fetch = async () => Response.json(snapshot);
    await assert.rejects(readRenderJobSnapshot('job'), RenderJobRequestError);
  }
  for (const status of ['queued', 'running', 'succeeded', 'failed'] as const) {
    globalThis.fetch = async () => Response.json({ status, progress: 50, failure: status === 'failed' ? failure : undefined });
    const snapshot = await readRenderJobSnapshot('job');
    assert.equal(snapshot.id, 'job');
    assert.equal(snapshot.status, status);
    if (status === 'failed') assert.deepEqual(snapshot.failure, failure);
  }

  const signal = new AbortController().signal;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.signal, signal);
    return String(url) === '/export/job'
      ? Response.json({ renderId: 'job' })
      : Response.json({ id: 'job', status: 'running', progress: 0 });
  };
  await submitRenderJob({}, signal);
  await readRenderJobSnapshot('job', signal);

  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, 'DELETE');
    return new Response(null, { status: 404 });
  };
  await cancelRenderJob('job');
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(cancelRenderJob('job'), RenderJobRequestError);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('render job client checks passed');
