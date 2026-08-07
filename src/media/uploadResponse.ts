import { normalizeSha256Hash } from '../../shared/content-hash';

export interface UploadedMediaLocation {
  src: string;
  sourceContentHash?: string;
}

/** Validate the untrusted upload JSON boundary while tolerating pre-hash servers. */
export function uploadedMediaLocation(
  value: unknown,
): UploadedMediaLocation | null {
  if (!value || typeof value !== 'object' || !('path' in value)
    || typeof value.path !== 'string' || !value.path.startsWith('/media/uploads/')) {
    return null;
  }
  const sourceContentHash = normalizeSha256Hash(
    'contentHash' in value ? value.contentHash : undefined,
  );
  return {
    src: value.path,
    ...(sourceContentHash ? { sourceContentHash } : {}),
  };
}

export function normalizeUploadedMediaLocation(
  value: string | UploadedMediaLocation,
): UploadedMediaLocation {
  return typeof value === 'string' ? { src: value } : value;
}
