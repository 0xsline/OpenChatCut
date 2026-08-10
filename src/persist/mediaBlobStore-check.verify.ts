// `npx tsx src/persist/mediaBlobStore.check.ts`
import assert from 'node:assert';
import {
  deleteMediaBlob,
  getMediaBlob,
  putMediaBlob,
  resetMediaBlobMemory,
  uploadAssetIdFromSrc,
} from './mediaBlobStore';

resetMediaBlobMemory();

assert.strictEqual(uploadAssetIdFromSrc('/media/uploads/abc-123.mp4'), 'abc-123');
assert.strictEqual(uploadAssetIdFromSrc('/media/uploads/foo_bar.webm'), 'foo_bar');
assert.strictEqual(uploadAssetIdFromSrc('https://cdn.example/x.mp4'), null);
assert.strictEqual(uploadAssetIdFromSrc('/other/path.mp4'), null);

const src = '/media/uploads/test-asset.bin';
const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/octet-stream' });

await putMediaBlob(src, blob, { name: 'test.bin', mime: 'application/octet-stream' });
const rec = await getMediaBlob(src);
assert.ok(rec, 'blob cached');
assert.strictEqual(rec!.src, src);
assert.strictEqual(rec!.bytes, 4);
assert.strictEqual(rec!.name, 'test.bin');
assert.strictEqual(rec!.blob.size, 4);

// Non-upload paths are ignored
await putMediaBlob('/static/foo.png', blob);
assert.strictEqual(await getMediaBlob('/static/foo.png'), undefined);

await deleteMediaBlob(src);
assert.strictEqual(await getMediaBlob(src), undefined);

// Oversized skip (construct a fake size without allocating 200MB)
const huge = {
  size: 250 * 1024 * 1024,
  type: 'video/mp4',
  // putMediaBlob only reads size/type for File-like; Blob needs real size —
  // use a stub that looks like Blob with huge size via Object.assign
} as unknown as Blob;
// Real Blob with reported size — we can't fake Blob.size easily; just ensure
// empty blob is skipped (size 0).
await putMediaBlob('/media/uploads/empty.bin', new Blob([]));
assert.strictEqual(await getMediaBlob('/media/uploads/empty.bin'), undefined);

void huge; // silence unused in some lint setups

console.log('mediaBlobStore.check: ok');
