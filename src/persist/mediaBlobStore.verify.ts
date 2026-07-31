import assert from 'node:assert/strict';
import {
  createMediaBlobImportNamespace, discardMediaBlobImport, getMediaBlob,
  mediaBlobStoreUsage, putMediaBlob, resetMediaBlobMemory, stageMediaBlobImport,
} from './mediaBlobStore';

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  resetMediaBlobMemory();
  const src = '/media/uploads/relinked.wav';
  let currentRevision = 'source-new';

  await putMediaBlob(src, new Blob(['stale']), {
    name: 'relinked.wav',
    mime: 'audio/wav',
    sourceRevision: 'source-old',
    isSourceRevisionCurrent: (revision) => revision === currentRevision,
  });
  assert.equal(await getMediaBlob(src), undefined, 'stale cache commit is rejected before persistence');

  await putMediaBlob(src, new Blob(['current']), {
    name: 'relinked.wav',
    mime: 'audio/wav',
    sourceRevision: currentRevision,
    sourceSize: 7,
    sourceModifiedAt: 123,
    isSourceRevisionCurrent: (revision) => revision === currentRevision,
  });
  const stored = await getMediaBlob(src);
  assert.equal(await stored?.blob.text(), 'current');
  assert.equal(stored?.sourceRevision, currentRevision, 'cache record carries the revision captured at work start');

  currentRevision = 'source-newer';
  await putMediaBlob(src, new Blob(['late old result']), {
    name: 'relinked.wav',
    mime: 'audio/wav',
    sourceRevision: 'source-new',
    isSourceRevisionCurrent: (revision) => revision === currentRevision,
  });
  assert.equal(await (await getMediaBlob(src))?.blob.text(), 'current', 'late stale work cannot replace the current cache entry');

  // Queue order is captured before asynchronous HEAD checks, so an older slow
  // cache write cannot finish after and overwrite a newer invocation.
  resetMediaBlobMemory();
  let releaseFirstHead!: () => void;
  const firstHead = new Promise<void>((resolve) => { releaseFirstHead = resolve; });
  let headCalls = 0;
  globalThis.fetch = async () => {
    headCalls += 1;
    if (headCalls === 1) await firstHead;
    return new Response(null, { status: 404 });
  };
  const older = putMediaBlob(src, new Blob(['older']), { sourceRevision: 'ordered-old' });
  await Promise.resolve();
  const newer = putMediaBlob(src, new Blob(['newer']), { sourceRevision: 'ordered-new' });
  releaseFirstHead();
  await Promise.all([older, newer]);
  const ordered = await getMediaBlob(src);
  assert.equal(await ordered?.blob.text(), 'newer', 'logical-key writes commit in invocation order');
  assert.equal(ordered?.sourceRevision, 'ordered-new');

  // Import staging is isolated from the real src and server, and namespace
  // cleanup removes only this import's temporary record.
  resetMediaBlobMemory();
  let importServerWrites = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') importServerWrites += 1;
    return new Response(null, { status: 404 });
  };
  await putMediaBlob(src, new Blob(['original']), { name: 'relinked.wav', mime: 'audio/wav' });
  const namespace = createMediaBlobImportNamespace();
  const staged = await stageMediaBlobImport(namespace, src, new Blob(['imported']), {
    name: 'relinked.wav',
    mime: 'audio/wav',
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('imported'));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(staged.src, `/media/uploads/sha256-${hex}.wav`);
  assert.notEqual(staged.src, src, 'package-controlled src is never selected as the global destination');
  assert.equal(await (await getMediaBlob(src))?.blob.text(), 'original');
  assert.equal(await (await getMediaBlob(staged.tempSrc))?.blob.text(), 'imported');
  assert.equal((await mediaBlobStoreUsage()).records, 2);
  assert.equal(importServerWrites, 0, 'temporary staging never reuploads');
  await discardMediaBlobImport(namespace);
  assert.equal(await getMediaBlob(staged.tempSrc), undefined);
  assert.equal(await (await getMediaBlob(src))?.blob.text(), 'original');
  assert.equal((await mediaBlobStoreUsage()).records, 1);
} finally {
  globalThis.fetch = originalFetch;
  resetMediaBlobMemory();
}

console.log('mediaBlobStore.verify: revision guards, ordered writes, and content-isolated import staging OK');
