import { heicTo } from 'heic-to/csp';
import type { MediaAsset, MediaAssetKind } from '../editor/types';
import { t } from '../i18n/locale';
import { kindOfDescriptor, probeMediaSource } from './mediaProbe';
import type { MobileUploadRecord } from './mobileUploadApi';
import { importMedia, normalizeUploadedVideo } from './upload';

const HEIC_EXTENSIONS = ['.heic', '.heif'];
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_JPEG_QUALITY = 0.92;

function isHeic(record: MobileUploadRecord): boolean {
  const name = record.name.toLowerCase();
  return HEIC_MIME_TYPES.has(record.mime.toLowerCase())
    || HEIC_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function jpegName(name: string): string {
  const replaced = name.replace(/\.(?:heic|heif)$/i, '.jpg');
  return replaced === name ? `${name}.jpg` : replaced;
}

async function convertHeic(record: MobileUploadRecord): Promise<File> {
  const response = await fetch(record.path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const converted = await heicTo({ blob: await response.blob(), type: 'image/jpeg', quality: HEIC_JPEG_QUALITY });
  const jpeg = Array.isArray(converted) ? converted[0] : converted;
  if (!(jpeg instanceof Blob)) throw new Error(t('HEIC Conversion failed'));
  return new File([jpeg], jpegName(record.name), { type: 'image/jpeg' });
}

async function importServerMedia(record: MobileUploadRecord, fps: number): Promise<MediaAsset> {
  const kind = kindOfDescriptor(record.name, record.mime);
  if (!kind) throw new Error(t('Unsupported file type (video / picture / Audio / GIF / SVG）'));
  const metadata = await probeMediaSource(record.path, kind, fps);
  if (kind !== 'video') {
    return { id: crypto.randomUUID(), name: record.name, kind: kind as MediaAssetKind, src: record.path, ...metadata };
  }
  const normalized = await normalizeUploadedVideo(record.path, fps);
  return {
    id: crypto.randomUUID(), name: record.name, kind, src: normalized.src,
    durationInFrames: normalized.durationSeconds
      ? Math.max(1, Math.round(normalized.durationSeconds * fps)) : metadata.durationInFrames,
    width: normalized.width ?? metadata.width,
    height: normalized.height ?? metadata.height,
  };
}

/** Build a project asset from a file already written by the phone-upload server. */
export async function importUploadedMedia(record: MobileUploadRecord, fps: number): Promise<MediaAsset> {
  if (isHeic(record)) return importMedia(await convertHeic(record), fps);
  return importServerMedia(record, fps);
}
