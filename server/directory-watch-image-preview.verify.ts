// Oversized still images get a downscaled preview on import so the preview
// player and still renderer never decode full phone-camera resolutions.
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  downscaleDirectoryImage,
  IMPORT_IMAGE_MAX_LONG_SIDE,
  imagePreviewName,
} from './directory-watch-import.ts';

const dir = await mkdtemp(join(tmpdir(), 'occ-image-preview-'));
try {
  const signal = new AbortController().signal;

  // A portrait phone photo larger than the cap gets a capped JPEG preview.
  const big = join(dir, 'big.jpg');
  await sharp({ create: { width: 3312, height: 5888, channels: 3, background: '#4a7' } }).jpeg().toFile(big);
  const preview = await downscaleDirectoryImage(big, signal);
  assert.equal(preview, join(dir, imagePreviewName('big.jpg', false)));
  const previewMeta = await sharp(preview!).metadata();
  assert.equal(previewMeta.height, IMPORT_IMAGE_MAX_LONG_SIDE, 'the long side is capped');
  assert.equal(previewMeta.width, Math.round(3312 * IMPORT_IMAGE_MAX_LONG_SIDE / 5888), 'the aspect ratio is kept');
  assert.ok((await stat(big)).size > 0, 'the original stays on disk');

  // Images already within the cap are published untouched.
  const small = join(dir, 'small.jpg');
  await sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#fff' } }).jpeg().toFile(small);
  assert.equal(await downscaleDirectoryImage(small, signal), null);

  // Transparency survives: alpha images get a PNG preview.
  const alpha = join(dir, 'logo.png');
  await sharp({ create: { width: 6000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png().toFile(alpha);
  const alphaPreview = await downscaleDirectoryImage(alpha, signal);
  assert.equal(alphaPreview, join(dir, imagePreviewName('logo.png', true)));
  const alphaMeta = await sharp(alphaPreview!).metadata();
  assert.equal(alphaMeta.hasAlpha, true);
  assert.equal(alphaMeta.width, IMPORT_IMAGE_MAX_LONG_SIDE);

  // EXIF orientation is applied, so a rotated landscape sensor image previews upright.
  const rotated = join(dir, 'rotated.jpg');
  await sharp({ create: { width: 5888, height: 3312, channels: 3, background: '#123' } })
    .withMetadata({ orientation: 6 }).jpeg().toFile(rotated);
  const rotatedMeta = await sharp((await downscaleDirectoryImage(rotated, signal))!).metadata();
  assert.equal(rotatedMeta.height, IMPORT_IMAGE_MAX_LONG_SIDE, 'orientation 6 renders portrait');

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(downscaleDirectoryImage(big, aborted.signal), /cancelled/);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('directory-watch-image-preview.verify: oversized stills get a capped, upright preview');
