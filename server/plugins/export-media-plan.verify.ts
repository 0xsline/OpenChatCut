import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportFailureError } from '../../src/export/exportFailure';
import { materializeServerExportMedia, validateServerExportMedia } from './export-media-plan';
import { acceptExportSubmission } from './export-submission';
// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import {
  assertMaterializedRenderSnapshot,
  withAbortableCompositionSelection,
} from '../../remotion/render.mjs';
import {
  enqueueUploadMutation,
  resolveOrHydrateUploadFile,
  type UploadHydrationDependencies,
} from '../media-dir';
import type { R2DownloadOptions } from '../r2';
import {
  safePublicFetch,
  type PinnedPublicRequest,
  type PublicUrlResolver,
  type PublicUrlTransport,
} from '../safe-public-fetch';

interface ProbeBodyState {
  cancels: number;
  reads: number;
}

function trackedProbeResponse(status: number, contentType: string, state: ProbeBodyState): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads += 1;
      controller.enqueue(Uint8Array.of(0));
      controller.close();
    },
    cancel() {
      state.cancels += 1;
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-export-preflight-'));
try {
  const readable = join(directory, 'readable.mp4');
  await writeFile(readable, 'media');
  let missingHydrateCalls = 0;
  const options = {
    publicDirectory: directory,
    uploadDirectory: directory,
    resolveUpload: (name: string) => name === 'readable.mp4' ? readable : null,
    hydrateUpload: async () => {
      missingHydrateCalls += 1;
      return null;
    },
  };
  await validateServerExportMedia({
    items: [{ id: 'ready', kind: 'video', src: '/media/uploads/readable.mp4' }],
  }, options);

  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'missing', kind: 'video', src: '/media/uploads/missing.mp4' }],
    }, options),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.stage === 'preflight'
      && error.failure.mediaIssues?.[0]?.code === 'missing_source'
      && error.failure.mediaIssues[0].itemId === 'missing'
      && error.failure.mediaIssues[0].source === '/media/uploads/missing.mp4',
  );
  assert.equal(missingHydrateCalls, 1, 'a local upload miss must consult cloud hydration exactly once');
  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'browser-only', kind: 'video', src: 'blob:browser-session' }],
    }, options),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.mediaIssues?.[0]?.code === 'unsupported_source',
  );
  const htmlFallback = {
    items: [
      { id: 'remote-html-200', kind: 'video', src: 'https://cdn.example.test/html-200.mp4' },
      { id: 'remote-html-206', kind: 'video', src: 'https://cdn.example.test/html-206.mp4' },
    ],
  };
  const htmlBodyState: ProbeBodyState = { cancels: 0, reads: 0 };
  const htmlRequests: Array<{ source: string; init: RequestInit }> = [];
  await assert.rejects(
    () => validateServerExportMedia(htmlFallback, {
      ...options,
      fetcher: async (input, init) => {
        const source = String(input);
        htmlRequests.push({ source, init: init ?? {} });
        return trackedProbeResponse(source.includes('206') ? 206 : 200, 'text/html; charset=utf-8', htmlBodyState);
      },
    }),
    (error: unknown) => {
      if (!(error instanceof ExportFailureError) || error.failure.code !== 'export_media_preflight_failed') return false;
      const issues = error.failure.mediaIssues ?? [];
      return issues.some((issue) => issue.code === 'missing_source'
        && issue.itemId === 'remote-html-200'
        && issue.source === 'https://cdn.example.test/html-200.mp4')
        && issues.some((issue) => issue.code === 'missing_source'
          && issue.itemId === 'remote-html-206'
          && issue.source === 'https://cdn.example.test/html-206.mp4');
    },
  );
  assert.equal(htmlRequests.length, 2);
  for (const request of htmlRequests) {
    assert.equal(request.init.method, 'GET');
    assert.equal(new Headers(request.init.headers).get('Range'), null);
    assert.equal(request.init.cache, 'no-store');
  }
  assert.equal(htmlBodyState.cancels, 2, 'remote HTML response bodies must be canceled');
  assert.equal(htmlBodyState.reads, 0, 'remote HTML response bodies must not be read');

  const successfulResponses: Record<string, { status: number; contentType: string } | undefined> = {
    'https://cdn.example.test/video.mp4': { status: 200, contentType: 'video/mp4' },
    'https://cdn.example.test/poster.png': { status: 200, contentType: 'image/png' },
    'https://cdn.example.test/audio.mp3': { status: 200, contentType: 'audio/mpeg' },
  };
  const successfulBodyState: ProbeBodyState = { cancels: 0, reads: 0 };
  const successfulRequests: Array<{ source: string; init: RequestInit }> = [];
  await validateServerExportMedia({
    items: [
      { id: 'remote-video', kind: 'video', src: 'https://cdn.example.test/video.mp4' },
      { id: 'remote-image', kind: 'image', src: 'https://cdn.example.test/poster.png' },
      { id: 'remote-audio', kind: 'audio', src: 'https://cdn.example.test/audio.mp3' },
    ],
  }, {
    ...options,
    fetcher: async (input, init) => {
      const source = String(input);
      const response = successfulResponses[source];
      assert.ok(response, `unexpected remote probe for ${source}`);
      successfulRequests.push({ source, init: init ?? {} });
      return trackedProbeResponse(response.status, response.contentType, successfulBodyState);
    },
  });
  assert.equal(successfulRequests.length, 3);
  for (const request of successfulRequests) {
    assert.equal(request.init.method, 'GET');
    assert.equal(new Headers(request.init.headers).get('Range'), null);
    assert.equal(request.init.cache, 'no-store');
  }
  assert.equal(successfulBodyState.cancels, 0, 'consumed remote media bodies must not require cancellation');
  assert.equal(successfulBodyState.reads, 3, 'successful remote media must be downloaded exactly once');

  const guardedRequests: PinnedPublicRequest[] = [];
  const guardedResolver: PublicUrlResolver = async (hostname) => hostname === 'private-media.example'
    ? [{ address: '10.0.0.8', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }];
  const guardedTransport: PublicUrlTransport = async (request) => {
    guardedRequests.push(request);
    if (request.url.hostname === 'redirect-media.example') {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/private.mp4' },
      });
    }
    return new Response(Uint8Array.of(1), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    });
  };
  const guardedFetcher: typeof safePublicFetch = (input, init) => safePublicFetch(input, {
    ...init,
    resolver: guardedResolver,
    transport: guardedTransport,
  });
  await validateServerExportMedia({
    items: [{ id: 'guarded-public', kind: 'video', src: 'https://public-media.example/video.mp4' }],
  }, { ...options, fetcher: guardedFetcher });
  assert.equal(guardedRequests.length, 1);
  assert.equal(guardedRequests[0]!.address, '93.184.216.34');
  assert.equal(guardedRequests[0]!.headers.get('Range'), null);

  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'guarded-private', kind: 'video', src: 'https://private-media.example/secret.mp4' }],
    }, { ...options, fetcher: guardedFetcher }),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.mediaIssues?.[0]?.itemId === 'guarded-private'
      && error.failure.mediaIssues[0].source === 'https://private-media.example/secret.mp4',
  );
  assert.equal(guardedRequests.length, 1, 'a directly private DNS result must never reach transport');

  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'guarded-redirect', kind: 'video', src: 'https://redirect-media.example/video.mp4' }],
    }, { ...options, fetcher: guardedFetcher }),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.mediaIssues?.[0]?.itemId === 'guarded-redirect'
      && error.failure.mediaIssues[0].source === 'https://redirect-media.example/video.mp4',
  );
  assert.equal(guardedRequests.length, 2, 'a private redirect target must be rejected before its transport');

  const remoteRenderState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [{
      id: 'remote-render-video',
      track: 'V1',
      startFrame: 0,
      durationInFrames: 30,
      name: 'Remote render video',
      kind: 'video' as const,
      src: 'https://rebinding-media.example/video.mp4',
    }],
  };
  assert.throws(
    () => assertMaterializedRenderSnapshot(remoteRenderState, 'render-still'),
    /external media .* was not materialized/,
    'the headless renderer must refuse an unmaterialized second load',
  );

  const inactiveRemote = 'https://inactive-media.example/broken.mp4';
  const unusedAssetRemote = 'https://unused-media.example/library.mp4';
  const inactiveProject = {
    activeTimelineId: 'timeline-active',
    assets: [{ id: 'unused-remote-asset', src: unusedAssetRemote }],
    timelines: [
      {
        id: 'timeline-active',
        items: [{ id: 'active-local', kind: 'video', src: '/media/uploads/readable.mp4' }],
      },
      {
        id: 'timeline-inactive',
        items: [{ id: 'inactive-remote', kind: 'video', src: inactiveRemote }],
      },
    ],
  };
  assert.doesNotThrow(
    () => assertMaterializedRenderSnapshot(inactiveProject, 'inactive-timeline-export'),
    'inactive timelines and unused assets are outside the renderer-visible closure',
  );
  let inactiveFetchCalls = 0;
  const inactiveMaterialized = await materializeServerExportMedia(inactiveProject, {
    ...options,
    fetcher: async () => {
      inactiveFetchCalls += 1;
      throw new Error('inactive media must not be fetched');
    },
  });
  assert.equal(inactiveFetchCalls, 0, 'inactive timelines and unused assets must not trigger a remote fetch');
  assert.equal(inactiveMaterialized.localPaths.length, 0);
  assert.equal(inactiveMaterialized.snapshot.timelines[1]?.items[0]?.src, inactiveRemote);
  assert.equal(inactiveMaterialized.snapshot.assets[0]?.src, unusedAssetRemote);
  assertMaterializedRenderSnapshot(inactiveMaterialized.snapshot, 'inactive-timeline-export');
  await inactiveMaterialized.cleanup();

  const nestedRemote = 'https://nested-media.example/reachable.mp4';
  const nestedProject = {
    activeTimelineId: 'timeline-root',
    assets: [],
    timelines: [
      {
        id: 'timeline-root',
        items: [{ id: 'nested-sequence', kind: 'sequence', timelineId: 'timeline-child' }],
      },
      {
        id: 'timeline-child',
        items: [{ id: 'nested-remote', kind: 'video', src: nestedRemote }],
      },
    ],
  };
  assert.throws(
    () => assertMaterializedRenderSnapshot(nestedProject, 'nested-sequence-export'),
    /external media .* was not materialized/,
    'reachable nested sequence media must remain behind the renderer guard',
  );
  const nestedFetchSources: string[] = [];
  const nestedMaterialized = await materializeServerExportMedia(nestedProject, {
    ...options,
    fetcher: async (input) => {
      nestedFetchSources.push(String(input));
      return new Response(Uint8Array.from([4, 5, 6]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '3' },
      });
    },
  });
  assert.deepEqual(nestedFetchSources, [nestedRemote]);
  assert.match(
    nestedMaterialized.snapshot.timelines[1]?.items[0]?.src ?? '',
    /^\/media\/uploads\/openchatcut-render-media-[0-9a-f-]+\.mp4$/,
  );
  assertMaterializedRenderSnapshot(nestedMaterialized.snapshot, 'nested-sequence-export');
  await nestedMaterialized.cleanup();

  for (const entrypoint of ['render-still', 'render-clip', 'export-job']) {
    let resolverCalls = 0;
    let transportCalls = 0;
    const rebindingResolver: PublicUrlResolver = async () => {
      resolverCalls += 1;
      return resolverCalls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.8', family: 4 }];
    };
    const rebindingTransport: PublicUrlTransport = async (request) => {
      transportCalls += 1;
      assert.equal(request.address, '93.184.216.34');
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '3' },
      });
    };
    const submission = await acceptExportSubmission(
      { state: remoteRenderState },
      {
        ...options,
        fetcher: (input, init) => safePublicFetch(input, {
          ...init,
          resolver: rebindingResolver,
          transport: rebindingTransport,
        }),
      },
    );
    const localSource = submission.plan.state.items[0]?.src;
    assert.match(localSource ?? '', /^\/media\/uploads\/openchatcut-render-media-[0-9a-f-]+\.mp4$/);
    assert.equal(Object.isFrozen(submission.plan.state), true, `${entrypoint} must render an immutable snapshot`);
    assertMaterializedRenderSnapshot(submission.plan.state, entrypoint);
    assert.equal(resolverCalls, 1, `${entrypoint} must not resolve remote media a second time in the renderer`);
    assert.equal(transportCalls, 1, `${entrypoint} must download legal public media exactly once`);
    assert.equal(await readFile(submission.materializedPaths[0]!, 'hex'), '010203');
    const materializedPath = submission.materializedPaths[0]!;
    await submission.cleanup();
    await assert.rejects(() => readFile(materializedPath), { code: 'ENOENT' });
  }

  let unsafeTransportCalls = 0;
  const unsafeFetcher: typeof safePublicFetch = (input, init) => safePublicFetch(input, {
    ...init,
    transport: async () => {
      unsafeTransportCalls += 1;
      return new Response(Uint8Array.of(1), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    },
  });
  const unsafeSources = [
    'http://127.0.0.1/private.mp4',
    'http://10.0.0.8/private.mp4',
    'http://metadata.google.internal/computeMetadata/v1/',
  ];
  for (const entrypoint of ['render-still', 'render-clip', 'export-job']) {
    for (const source of unsafeSources) {
      await assert.rejects(
        () => acceptExportSubmission({
          state: {
            ...remoteRenderState,
            items: [{ ...remoteRenderState.items[0], src: source }],
          },
        }, { ...options, fetcher: unsafeFetcher }),
        (error: unknown) => error instanceof ExportFailureError
          && error.failure.stage === 'preflight'
          && error.failure.mediaIssues?.[0]?.source === source,
        `${entrypoint} must reject ${source} before rendering`,
      );
    }
  }
  assert.equal(unsafeTransportCalls, 0, 'loopback, private, and metadata URLs must never reach transport');
  await assert.rejects(
    () => validateServerExportMedia({
      ...remoteRenderState,
      items: [{ ...remoteRenderState.items[0], src: 'https://public-media.example/truncated.mp4' }],
    }, {
      ...options,
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1));
          controller.error(new Error('upstream body failed'));
        },
      }), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    }),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.stage === 'preflight',
  );
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith('openchatcut-render-media-')),
    [],
    'failed materialization must remove both partial and published files',
  );
  const materializationAbort = new AbortController();
  const materializationAbortReason = new DOMException('disconnect during materialization', 'AbortError');
  let materializationFetchSignalAborted = false;
  await assert.rejects(
    () => materializeServerExportMedia({
      ...remoteRenderState,
      items: [{ ...remoteRenderState.items[0], src: 'https://public-media.example/abort.mp4' }],
    }, {
      ...options,
      signal: materializationAbort.signal,
      fetcher: async (_input, init) => {
        const fetchSignal = init?.signal;
        assert.ok(fetchSignal);
        fetchSignal.addEventListener('abort', () => {
          materializationFetchSignalAborted = true;
        }, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(Uint8Array.of(1, 2, 3));
            materializationAbort.abort(materializationAbortReason);
          },
        }, { highWaterMark: 0 }), {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      },
    }),
    (error: unknown) => error === materializationAbortReason,
  );
  assert.equal(materializationFetchSignalAborted, true, 'request abort must reach safePublicFetch');
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith('openchatcut-render-media-')),
    [],
    'aborted materialization must remove its partial file',
  );
  const cloudHydrateCalls: string[] = [];
  await validateServerExportMedia({
    items: [{ id: 'cloud-ready', kind: 'video', src: '/media/uploads/cloud-ready.mp4' }],
  }, {
    ...options,
    hydrateUpload: async (name) => {
      cloudHydrateCalls.push(name);
      return {
        file: readable,
        contentType: 'video/mp4',
        bytes: 5,
        cached: false,
      };
    },
  });
  assert.deepEqual(cloudHydrateCalls, ['cloud-ready.mp4']);

  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'cloud-html', kind: 'video', src: '/media/uploads/cloud-html.mp4' }],
    }, {
      ...options,
      hydrateUpload: async () => ({
        file: readable,
        contentType: 'text/html; charset=utf-8',
        bytes: 5,
        cached: false,
      }),
    }),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.mediaIssues?.[0]?.code === 'missing_source'
      && error.failure.mediaIssues[0].itemId === 'cloud-html'
      && error.failure.mediaIssues[0].source === '/media/uploads/cloud-html.mp4',
  );

  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'cloud-unreadable', kind: 'video', src: '/media/uploads/cloud-unreadable.mp4' }],
    }, {
      ...options,
      hydrateUpload: async () => ({
        file: join(directory, 'cloud-unreadable.mp4'),
        contentType: 'video/mp4',
        bytes: 5,
        cached: false,
      }),
    }),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.mediaIssues?.[0]?.code === 'unreadable'
      && error.failure.mediaIssues[0].itemId === 'cloud-unreadable'
      && error.failure.mediaIssues[0].source === '/media/uploads/cloud-unreadable.mp4',
  );

  let traversalHydrateCalls = 0;
  await assert.rejects(
    () => validateServerExportMedia({
      items: [{ id: 'cloud-traversal', kind: 'video', src: '/media/uploads/%2e%2e%2fsecret.mp4' }],
    }, {
      ...options,
      hydrateUpload: async () => {
        traversalHydrateCalls += 1;
        return null;
      },
    }),
    (error: unknown) => error instanceof ExportFailureError
      && error.failure.mediaIssues?.[0]?.code === 'unsupported_source'
      && error.failure.mediaIssues[0].itemId === 'cloud-traversal'
      && error.failure.mediaIssues[0].source === '/media/uploads/%2e%2e%2fsecret.mp4',
  );
  assert.equal(traversalHydrateCalls, 0, 'unsafe upload names must never reach cloud hydration');

  let concurrentDownloads = 0;
  const completeCloudMedia = 'complete-cloud-media';
  const singleFlightDependencies: UploadHydrationDependencies = {
    resolveLocal: () => null,
    cloudAvailable: () => true,
    uploadDirectory: () => directory,
    downloadToFile: async (_name, destination) => {
      concurrentDownloads += 1;
      await writeFile(destination, completeCloudMedia);
      return { contentType: 'video/mp4', bytes: completeCloudMedia.length };
    },
  };
  const [firstHydration, secondHydration] = await Promise.all([
    resolveOrHydrateUploadFile('single-flight.mp4', singleFlightDependencies),
    resolveOrHydrateUploadFile('single-flight.mp4', singleFlightDependencies),
  ]);
  assert.equal(concurrentDownloads, 1, 'concurrent readers must share one remote download/write');
  assert.ok(firstHydration);
  assert.ok(secondHydration);
  assert.strictEqual(firstHydration, secondHydration, 'concurrent readers must receive the same hydration result');
  assert.equal(firstHydration.file, secondHydration.file);
  assert.equal(await readFile(firstHydration.file, 'utf8'), completeCloudMedia);

  let hydrationStarted!: () => void;
  let releaseHydration!: () => void;
  const hydrationHasSnapshot = new Promise<void>((resolve) => { hydrationStarted = resolve; });
  const hydrationMayPublish = new Promise<void>((resolve) => { releaseHydration = resolve; });
  const hydrationRaceName = 'hydration-upload-race.mp4';
  const hydrationRacePath = join(directory, hydrationRaceName);
  const hydrationRace = resolveOrHydrateUploadFile(hydrationRaceName, {
    resolveLocal: () => null,
    cloudAvailable: () => true,
    uploadDirectory: () => directory,
    downloadToFile: async (_name, destination) => {
      await writeFile(destination, 'stale-cloud-snapshot');
      hydrationStarted();
      await hydrationMayPublish;
      return { contentType: 'video/mp4', bytes: 20 };
    },
  });
  await hydrationHasSnapshot;
  const ordinaryUpload = enqueueUploadMutation(hydrationRaceName, async () => {
    await writeFile(hydrationRacePath, 'fresh-upload');
  });
  releaseHydration();
  await Promise.all([hydrationRace, ordinaryUpload]);
  assert.equal(
    await readFile(hydrationRacePath, 'utf8'),
    'fresh-upload',
    'a stale hydration snapshot must publish before, never over, a queued same-name upload',
  );

  let retryDownloads = 0;
  const completeRetryMedia = 'complete-after-retry';
  const retryDependencies: UploadHydrationDependencies = {
    resolveLocal: () => null,
    cloudAvailable: () => true,
    uploadDirectory: () => directory,
    downloadToFile: async (_name, destination) => {
      retryDownloads += 1;
      if (retryDownloads === 1) {
        await writeFile(destination, 'partial');
        throw new Error('first hydration failed');
      }
      await writeFile(destination, completeRetryMedia);
      return { contentType: 'video/mp4', bytes: completeRetryMedia.length };
    },
  };
  await assert.rejects(
    () => resolveOrHydrateUploadFile('retry-after-failure.mp4', retryDependencies),
    /first hydration failed/,
  );
  const retryHydration = await resolveOrHydrateUploadFile('retry-after-failure.mp4', retryDependencies);
  assert.equal(retryDownloads, 2, 'a failed hydration must leave no stale in-flight entry');
  assert.ok(retryHydration);
  assert.equal(await readFile(retryHydration.file, 'utf8'), completeRetryMedia);
  const hydrationAbort = new AbortController();
  const hydrationAbortReason = new DOMException('disconnect during hydration', 'AbortError');
  const hydrationAbortName = 'abort-hydration.mp4';
  await assert.rejects(
    () => resolveOrHydrateUploadFile(hydrationAbortName, {
      resolveLocal: () => null,
      cloudAvailable: () => true,
      uploadDirectory: () => directory,
      downloadToFile: async (
        _name: string,
        destination: string,
        downloadOptions?: R2DownloadOptions,
      ) => {
        assert.strictEqual(downloadOptions?.signal, hydrationAbort.signal);
        await writeFile(destination, 'partial-hydration');
        hydrationAbort.abort(hydrationAbortReason);
        return { contentType: 'video/mp4', bytes: 17 };
      },
    }, hydrationAbort.signal),
    (error: unknown) => error === hydrationAbortReason,
  );
  const hydrationAbortEntries = await readdir(directory);
  assert.equal(hydrationAbortEntries.includes(`.${hydrationAbortName}.part`), false);
  assert.equal(hydrationAbortEntries.includes(hydrationAbortName), false);

  const selectionAbort = new AbortController();
  const selectionAbortReason = new DOMException('disconnect during composition selection', 'AbortError');
  let browserCloseCalls = 0;
  let renderMediaCalls = 0;
  const fakeBrowser = {
    async close() {
      browserCloseCalls += 1;
    },
  };
  await assert.rejects(
    () => withAbortableCompositionSelection({
      signal: selectionAbort.signal,
      selectionOptions: {
        serveUrl: '/fake-bundle',
        id: 'timeline',
        inputProps: {},
      },
      openBrowserImpl: async () => fakeBrowser,
      selectCompositionImpl: async ({ puppeteerInstance }: { puppeteerInstance: unknown }) => {
        assert.strictEqual(puppeteerInstance, fakeBrowser);
        selectionAbort.abort(selectionAbortReason);
        return { id: 'timeline' };
      },
      run: async () => {
        renderMediaCalls += 1;
      },
    }),
    (error: unknown) => error === selectionAbortReason,
  );
  assert.equal(browserCloseCalls, 1, 'selection abort must close the owned browser boundary');
  assert.equal(renderMediaCalls, 0, 'selection abort must not enter renderMedia');
  console.log('server export media preflight verification passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
