export type ExternalUploadAssetType = 'audio' | 'gif' | 'image' | 'svg' | 'video';

export interface ExternalUploadMediaType {
  assetType: ExternalUploadAssetType;
  contentType: string;
  extension: string;
}

const MEDIA_TYPES: readonly ExternalUploadMediaType[] = [
  { assetType: 'video', contentType: 'video/mp4', extension: '.mp4' },
  { assetType: 'video', contentType: 'video/x-m4v', extension: '.m4v' },
  { assetType: 'video', contentType: 'video/quicktime', extension: '.mov' },
  { assetType: 'video', contentType: 'video/webm', extension: '.webm' },
  { assetType: 'image', contentType: 'image/jpeg', extension: '.jpg' },
  { assetType: 'image', contentType: 'image/png', extension: '.png' },
  { assetType: 'image', contentType: 'image/webp', extension: '.webp' },
  { assetType: 'image', contentType: 'image/avif', extension: '.avif' },
  { assetType: 'image', contentType: 'image/heic', extension: '.heic' },
  { assetType: 'image', contentType: 'image/heif', extension: '.heif' },
  { assetType: 'gif', contentType: 'image/gif', extension: '.gif' },
  { assetType: 'svg', contentType: 'image/svg+xml', extension: '.svg' },
  { assetType: 'audio', contentType: 'audio/mpeg', extension: '.mp3' },
  { assetType: 'audio', contentType: 'audio/wav', extension: '.wav' },
  { assetType: 'audio', contentType: 'audio/x-wav', extension: '.wav' },
  { assetType: 'audio', contentType: 'audio/mp4', extension: '.m4a' },
  { assetType: 'audio', contentType: 'audio/x-m4a', extension: '.m4a' },
  { assetType: 'audio', contentType: 'audio/aac', extension: '.aac' },
  { assetType: 'audio', contentType: 'audio/ogg', extension: '.ogg' },
  { assetType: 'audio', contentType: 'audio/opus', extension: '.opus' },
  { assetType: 'audio', contentType: 'audio/flac', extension: '.flac' },
  { assetType: 'audio', contentType: 'audio/x-flac', extension: '.flac' },
];

export function externalUploadMediaType(
  assetType: unknown,
  contentType: unknown,
): ExternalUploadMediaType | null {
  if (typeof assetType !== 'string' || typeof contentType !== 'string') return null;
  const normalized = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return MEDIA_TYPES.find((entry) => (
    entry.assetType === assetType && entry.contentType === normalized
  )) ?? null;
}
