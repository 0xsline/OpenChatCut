import assert from 'node:assert/strict';
import { ExportFailureError } from './exportFailure';
import { materializeBlobMedia } from './materializeBlobMedia';

const BLOB_A = 'blob:http://127.0.0.1:5199/aaa';
const BLOB_B = 'blob:http://127.0.0.1:5199/bbb';

interface FakeUpload {
  name: string;
  body: BodyInit | null | undefined;
}

function makeFetcher(overrides: {
  blobStatus?: (url: string) => number;
  blobRequests?: string[];
  uploadStatus?: number;
  uploadError?: string;
  uploads?: FakeUpload[];
} = {}) {
  const uploads = overrides.uploads ?? [];
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('blob:')) {
      overrides.blobRequests?.push(url);
      const status = overrides.blobStatus?.(url) ?? 200;
      if (status !== 200) return new Response(null, { status });
      const type = url === BLOB_A ? 'image/png' : 'video/mp4';
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type }), { status: 200 });
    }
    if (url.startsWith('/upload')) {
      if (overrides.uploadError) {
        return Response.json({ error: overrides.uploadError }, { status: 500 });
      }
      const name = new URL(url, 'http://x').searchParams.get('name') ?? '';
      uploads.push({ name, body: init?.body });
      return Response.json({ path: `/media/uploads/${name}`, created: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}
async function startExportJobAfterMaterialization<T extends object>(
  snapshot: T,
  fetcher: typeof fetch,
  jobs: T[],
): Promise<void> {
  jobs.push(await materializeBlobMedia(snapshot, { fetcher }));
}

const projectWithBlobs = {
  activeTimelineId: 'main',
  assets: [
    { id: 'asset-a', kind: 'image', name: '星图.png', src: BLOB_A, durationInFrames: 90 },
    { id: 'asset-b', kind: 'video', name: 'clip.mp4', src: BLOB_B, durationInFrames: 300 },
  ],
  timelines: [
    {
      id: 'main',
      items: [
        { id: 'item-a', kind: 'image', name: '星图.png', src: BLOB_A, durationInFrames: 90 },
        { id: 'item-b', kind: 'video', name: 'clip.mp4', src: BLOB_B, durationInFrames: 300 },
      ],
    },
  ],
};

async function main(): Promise<void> {
  // 1. No blob sources → identical snapshot reference, zero work.
  const clean = { items: [{ id: 'x', src: '/media/uploads/ok.mp4' }] };
  const cleanResult = await materializeBlobMedia(clean, { fetcher: makeFetcher() });
  assert.equal(cleanResult, clean);

  // 2. Readable blobs are uploaded once and every reference is replaced.
  const uploads: FakeUpload[] = [];
  const fetcher = makeFetcher({ uploads });
  const result = await materializeBlobMedia(projectWithBlobs, { fetcher });
  assert.equal(uploads.length, 2, 'each distinct blob source uploads exactly once');
  const snapshot = result;
  assert.equal(snapshot.assets[0]!.src, '/media/uploads/星图-blob.png');
  assert.equal(snapshot.assets[1]!.src, '/media/uploads/clip-blob.mp4');
  assert.equal(snapshot.timelines[0]!.items[0]!.src, snapshot.assets[0]!.src, 'item and asset share the same replacement');
  assert.equal(snapshot.timelines[0]!.items[1]!.src, snapshot.assets[1]!.src);
  assert.ok(projectWithBlobs.assets[0]!.src.startsWith('blob:'), 'original snapshot untouched');

  // 3. One readable and one revoked blob still blocks submission. The failure
  // identifies the revoked asset even though the readable source uploaded.
  const partialUploads: FakeUpload[] = [];
  const partial = makeFetcher({
    blobStatus: (url) => (url === BLOB_B ? 404 : 200),
    uploads: partialUploads,
  });
  const createdJobs: Array<typeof projectWithBlobs> = [];
  await assert.rejects(
    () => startExportJobAfterMaterialization(projectWithBlobs, partial, createdJobs),
    (error: unknown) => {
      assert.ok(error instanceof ExportFailureError);
      assert.equal(error.failure.code, 'export_media_not_ready');
      assert.equal(error.failure.stage, 'preflight');
      assert.equal(error.failure.retryable, false);
      assert.match(error.message, /clip\.mp4/);
      assert.match(error.message, new RegExp(BLOB_B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(error.message, /重新导入|re-import/);
      return true;
    },
  );
  assert.equal(partialUploads.length, 1, 'the readable blob may publish while preflight checks every source');
  assert.equal(createdJobs.length, 0, 'a partial materialization must not create an export job');

  const successfulJobs: Array<typeof projectWithBlobs> = [];
  await startExportJobAfterMaterialization(projectWithBlobs, makeFetcher(), successfulJobs);
  assert.equal(successfulJobs.length, 1, 'all-success materialization proceeds to job creation');
  assert.equal(successfulJobs[0]!.assets.every((asset) => !asset.src.startsWith('blob:')), true);

  // 4. Revoked blobs in the unused pool or an inactive timeline are outside
  // the renderer closure and therefore do not block the active timeline.
  const inactiveRequests: string[] = [];
  const inactive = {
    activeTimelineId: 'main',
    assets: [
      { id: 'unused-asset', kind: 'video', name: 'unused.mp4', src: BLOB_B, durationInFrames: 30 },
    ],
    timelines: [
      {
        id: 'main',
        items: [{ id: 'active-item', kind: 'image', name: 'active.png', src: BLOB_A, durationInFrames: 30 }],
      },
      {
        id: 'inactive',
        items: [{ id: 'inactive-item', kind: 'video', name: 'inactive.mp4', src: BLOB_B, durationInFrames: 30 }],
      },
    ],
  };
  const workflowSnapshot = {
    state: inactive.timelines[0]!,
    project: inactive,
    timelineId: 'main',
  };
  const inactiveSnapshot = await materializeBlobMedia(workflowSnapshot, {
    mediaPlanSnapshot: { ...inactive, activeTimelineId: workflowSnapshot.timelineId },
    fetcher: makeFetcher({
      blobRequests: inactiveRequests,
      blobStatus: (url) => (url === BLOB_B ? 404 : 200),
    }),
  });
  assert.deepEqual(inactiveRequests, [BLOB_A], 'only renderer-reachable blob sources are fetched');
  assert.equal(inactiveSnapshot.state.items[0]!.src.startsWith('/media/uploads/'), true);
  assert.equal(inactiveSnapshot.project.timelines[0]!.items[0]!.src, inactiveSnapshot.state.items[0]!.src);
  assert.equal(inactiveSnapshot.project.assets[0]!.src, BLOB_B, 'unused pool source stays untouched');
  assert.equal(inactiveSnapshot.project.timelines[1]!.items[0]!.src, BLOB_B, 'inactive timeline source stays untouched');

  // 5. All blobs unpublishable → preflight ExportFailureError with user-facing message.
  const allBroken = makeFetcher({ blobStatus: () => 404 });
  await assert.rejects(
    () => materializeBlobMedia(projectWithBlobs, { fetcher: allBroken }),
    (error: unknown) => {
      assert.ok(error instanceof ExportFailureError);
      assert.equal(error.failure.code, 'export_media_not_ready');
      assert.equal(error.failure.stage, 'preflight');
      assert.equal(error.failure.retryable, false);
      assert.ok(error.message.trim(), 'preflight failure remains user-facing in every locale');
      return true;
    },
  );

  // 6. Every blob unpublishable (upload failure) → preflight failure.
  const uploadBroken = makeFetcher({ uploadError: 'disk full' });
  await assert.rejects(
    () => materializeBlobMedia(projectWithBlobs, { fetcher: uploadBroken }),
    (error: unknown) => {
      assert.ok(error instanceof ExportFailureError);
      assert.equal(error.failure.code, 'export_media_not_ready');
      assert.equal(error.failure.retryable, false);
      assert.match(error.message, /disk full|上传/);
      return true;
    },
  );

  // 7. Nested media fields (effects / transitions / captions) are replaced too.
  const nested = {
    assets: [{ id: 'lut', kind: 'image', name: 'look.cube', src: BLOB_A, durationInFrames: 90 }],
    timelines: [{
      id: 'main',
      items: [{ id: 'v', kind: 'video', src: '/media/uploads/v.mp4', effects: [{ id: 'e', assetId: 'lut' }] }],
      fxDefs: { lut: { cube: BLOB_B } },
      transitions: [{ maskSrc: BLOB_A }],
      captions: { backgroundImageUrl: BLOB_B },
    }],
  };
  const nestedSnapshot = await materializeBlobMedia(nested, { fetcher: makeFetcher({ uploads: [] }) });
  assert.equal(nestedSnapshot.timelines[0]!.fxDefs!.lut.cube.startsWith('/media/uploads/'), true);
  assert.equal(nestedSnapshot.timelines[0]!.transitions[0]!.maskSrc, nestedSnapshot.assets[0]!.src);
  assert.equal(nestedSnapshot.timelines[0]!.captions.backgroundImageUrl, nestedSnapshot.timelines[0]!.fxDefs!.lut.cube);

  console.log('materializeBlobMedia.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
