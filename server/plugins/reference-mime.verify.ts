// Runnable check: `npx tsx server/plugins/reference-mime.verify.ts`.
//
// Take the real code path: put several temporary files with different extensions in the upload directory, and call the real reference assets for suppliers
// mediaDataUrl(), asserts that the data: prefix indicates the **real type**.
//
// There is originally a copy of MIME here that only recognizes 6 extensions, and the rest are all image/jpeg - `.heic`
// `.avif` `.gif` `.mov` These types can indeed enter /media/uploads and will be labeled image/jpeg
// Send to vendor along with non-JPEG bytes.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadDir } from '../media-dir.ts';
import { mediaDataUrl } from './video-media.ts';

const dir = uploadDir();
await mkdir(dir, { recursive: true });

const CASES: Array<[ext: string, mime: string]> = [
  ['mov', 'video/quicktime'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['avif', 'image/avif'],
  ['gif', 'image/gif'],
  ['m4v', 'video/mp4'],
  ['m4a', 'audio/mp4'],
  ['flac', 'audio/flac'],
  // The ones that are already recognized must remain unchanged.
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['mp4', 'video/mp4'],
  ['wav', 'audio/wav'],
  ['jpg', 'image/jpeg'],
];

const written: string[] = [];
try {
  for (const [ext, mime] of CASES) {
    const name = `verify-mime-probe.${ext}`;
    const file = join(dir, name);
    await writeFile(file, Buffer.from([1, 2, 3, 4]));
    written.push(file);
    const url = await mediaDataUrl(`/media/uploads/${name}`);
    assert.ok(
      url.startsWith(`data:${mime};base64,`),
      `.${ext} 应标成 ${mime},实得 ${url.slice(0, url.indexOf(';base64'))}`,
    );
  }
  console.log(`reference-mime.verify: ok (${CASES.length} 种扩展名都标了真实类型,没有兜底成 image/jpeg)`);
} finally {
  await Promise.all(written.map((file) => rm(file, { force: true })));
}
