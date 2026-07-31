import assert from 'node:assert/strict';
import {
  createServerExporter,
  isServerRenderError,
} from './serverExportOperation';
import type { ExportDestination } from './exportDestination';

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const grantId = 'a'.repeat(43);
const destination: ExportDestination = { type: 'desktop-directory', grantId, label: 'Exports' };
const noop = () => undefined;

function exporter() {
  return createServerExporter({
    autoQaEnabled: false,
    destination,
    options: {
      state: {} as never,
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
    },
    setBusy: noop,
    setEngineInfo: noop,
    setEngineReason: noop,
    setProgress: noop,
    setRenderEngine: noop,
    t: (key) => key,
    verifyCompletedExport: async () => undefined,
  });
}

async function verifyRenderFailureIsTypedAndDeleted(): Promise<void> {
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/export/job') return Response.json({ renderId: 'render-failed' });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ status: 'failed', progress: 1, error: 'renderer failed' });
  }) as typeof fetch;
  await assert.rejects(
    exporter()('video'),
    (error) => isServerRenderError(error) && error.message === 'renderer failed',
  );
  assert.deepEqual(requests, [
    'POST /export/job',
    'GET /export/job/render-failed',
    'DELETE /export/job/render-failed',
  ]);
}

async function verifyDeliveryFailureDoesNotTriggerRenderFallback(): Promise<void> {
  const requests: string[] = [];
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
    if (url.startsWith('/api/export-destinations/')) return new Response('disk full', { status: 507 });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  await assert.rejects(
    exporter()('video'),
    (error) => error instanceof Error
      && error.name === 'ExportDestinationError'
      && error.message === '写入导出目录失败（HTTP {status}）',
  );
  assert.equal(requests.at(-1), 'DELETE /export/job/render-succeeded');
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

try {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'http://localhost:5199/' } },
  });
  await verifyRenderFailureIsTypedAndDeleted();
  await verifyDeliveryFailureDoesNotTriggerRenderFallback();
  await verifyPollFailureDoesNotTriggerRenderFallback();
  await verifyCancellationDeletesActiveJob();
  console.log('server export operation verification passed');
} finally {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
}
