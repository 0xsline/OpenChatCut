// Runnable check: `npx tsx server/plugins/reference-mime.verify.ts`.
//
// 走真实代码路径:在上传目录里放几个不同扩展名的临时文件,调用真正给供应商拼参考素材
// 的 mediaDataUrl(),断言 data: 前缀标的是**真实类型**。
//
// 这里原本有一份只认 6 种扩展名的 MIME 副本,其余一律兜底成 image/jpeg——`.heic`
// `.avif` `.gif` `.mov` 这些确实能进 /media/uploads 的类型,会被贴上 image/jpeg 标签
// 连同非 JPEG 字节一起发给供应商。
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
  // 原本就认得的几种必须保持不变
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
