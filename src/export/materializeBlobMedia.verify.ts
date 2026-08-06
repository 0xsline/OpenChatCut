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
  uploadStatus?: number;
  uploadError?: string;
  uploads?: FakeUpload[];
} = {}) {
  const uploads = overrides.uploads ?? [];
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('blob:')) {
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
  assert.equal(cleanResult.snapshot, clean);
  assert.equal(cleanResult.replaced, 0);
  assert.deepEqual(cleanResult.failed, []);

  // 2. Readable blobs are uploaded once and every reference is replaced.
  const uploads: FakeUpload[] = [];
  const fetcher = makeFetcher({ uploads });
  const result = await materializeBlobMedia(projectWithBlobs, { fetcher });
  assert.equal(result.replaced, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(uploads.length, 2, 'each distinct blob source uploads exactly once');
  const snapshot = result.snapshot as typeof projectWithBlobs;
  assert.ok(snapshot !== projectWithBlobs, 'materialized snapshot must be a new object');
  assert.equal(snapshot.assets[0]!.src, '/media/uploads/星图-blob.png');
  assert.equal(snapshot.assets[1]!.src, '/media/uploads/clip-blob.mp4');
  assert.equal(snapshot.timelines[0]!.items[0]!.src, snapshot.assets[0]!.src, 'item and asset share the same replacement');
  assert.equal(snapshot.timelines[0]!.items[1]!.src, snapshot.assets[1]!.src);
  assert.ok(projectWithBlobs.assets[0]!.src.startsWith('blob:'), 'original snapshot untouched');

  // 3. A revoked blob is collected as failed; readable ones still publish.
  const partial = makeFetcher({ blobStatus: (url) => (url === BLOB_B ? 404 : 200), uploads: [] });
  const partialResult = await materializeBlobMedia(projectWithBlobs, { fetcher: partial });
  assert.equal(partialResult.replaced, 1);
  assert.equal(partialResult.failed.length, 1);
  assert.equal(partialResult.failed[0]!.source, BLOB_B);
  const partialSnapshot = partialResult.snapshot as typeof projectWithBlobs;
  assert.equal(partialSnapshot.assets[0]!.src.startsWith('/media/uploads/'), true);
  assert.equal(partialSnapshot.assets[1]!.src, BLOB_B, 'unpublishable blob stays put');

  // 4. All blobs unpublishable → preflight ExportFailureError with user-facing message.
  const allBroken = makeFetcher({ blobStatus: () => 404 });
  await assert.rejects(
    () => materializeBlobMedia(projectWithBlobs, { fetcher: allBroken }),
    (error: unknown) => {
      assert.ok(error instanceof ExportFailureError);
      assert.equal(error.failure.code, 'export_media_not_ready');
      assert.equal(error.failure.stage, 'preflight');
      assert.equal(error.failure.retryable, false);
      assert.match(error.message, /未就绪/);
      return true;
    },
  );

  // 5. Every blob unpublishable (upload failure) → preflight failure.
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

  // 6. Nested media fields (effects / transitions / captions) are replaced too.
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
  const nestedResult = await materializeBlobMedia(nested, { fetcher: makeFetcher({ uploads: [] }) });
  assert.equal(nestedResult.replaced, 2);
  const nestedSnapshot = nestedResult.snapshot as typeof nested;
  assert.equal(nestedSnapshot.timelines[0]!.fxDefs!.lut.cube.startsWith('/media/uploads/'), true);
  assert.equal(nestedSnapshot.timelines[0]!.transitions[0]!.maskSrc, nestedSnapshot.assets[0]!.src);
  assert.equal(nestedSnapshot.timelines[0]!.captions.backgroundImageUrl, nestedSnapshot.timelines[0]!.fxDefs!.lut.cube);

  console.log('materializeBlobMedia.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
