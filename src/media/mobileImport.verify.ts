import assert from 'node:assert/strict';
import type { MediaAsset } from '../editor/types';
import { importUploadedMedia, preserveMobileSourceIdentity } from './mobileImport';
import type { MobileUploadRecord } from './mobileUploadApi';

const originalImage = globalThis.Image;
class FailedImageProbe {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onerror?.());
  }
}
globalThis.Image = FailedImageProbe as unknown as typeof Image;

try {
  const mobileRecord: MobileUploadRecord = {
    id: 'mobile-image-1',
    name: 'phone-photo.png',
    mime: 'image/png',
    bytes: 1234,
    path: '/media/mobile/session/phone-photo.png',
    createdAt: 1_782_000_000_000,
  };
  const imported = await importUploadedMedia(mobileRecord, 30);
  assert.equal(imported.sourceFilename, 'phone-photo.png');
  assert.equal(imported.originalFilePath, undefined, 'mobile server records never create desktop paths');

  const convertedJpeg: MediaAsset = {
    id: 'converted-heic-1',
    name: 'IMG_0001.jpg',
    sourceFilename: 'IMG_0001.jpg',
    originalFilePath: '/tmp/incorrect-browser-path/IMG_0001.jpg',
    kind: 'image',
    src: '/media/uploads/converted.jpg',
    durationInFrames: 150,
  };
  const heicImport = preserveMobileSourceIdentity(convertedJpeg, 'IMG_0001.HEIC');
  assert.equal(heicImport.name, 'IMG_0001.jpg', 'the display name follows the converted JPEG');
  assert.equal(heicImport.sourceFilename, 'IMG_0001.HEIC', 'source identity remains the phone filename before conversion');
  assert.equal(heicImport.originalFilePath, undefined, 'converted mobile media cannot inherit a desktop path');
} finally {
  globalThis.Image = originalImage;
}

console.log('mobile import source identity verify: ok');
