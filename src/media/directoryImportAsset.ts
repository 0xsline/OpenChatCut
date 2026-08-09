import type { DirectoryImportedFile } from '../../shared/directory-import';
import { normalizeSha256Hash } from '../../shared/content-hash';
import { createMediaSourceRevision } from '../editor/mediaSourceRevision';
import type { MediaAsset, MediaAssetKind } from '../editor/types';
import { t } from '../i18n/locale';

const FALLBACK_SECONDS = 5;

interface DirectoryImportAssetDependencies {
  createId?: () => string;
}

function durationInProjectFrames(file: DirectoryImportedFile, projectFps: number): number {
  if (file.kind === 'image' || file.kind === 'svg') {
    return Math.max(1, Math.round(FALLBACK_SECONDS * projectFps));
  }
  const seconds = file.durationSeconds && file.durationSeconds > 0
    ? file.durationSeconds
    : FALLBACK_SECONDS;
  return Math.max(1, Math.round(seconds * projectFps));
}

function assertPublishedVideoIsReady(file: DirectoryImportedFile): void {
  if (file.kind !== 'video' || file.proxyKind === 'alpha-webm') return;
  if (file.compatibilityNormalized !== true) {
    throw new Error(t('监听目录中的视频尚未完成兼容性处理'));
  }
}

export async function directoryFileToAsset(
  file: DirectoryImportedFile,
  projectFps: number,
  dependencies: DirectoryImportAssetDependencies = {},
): Promise<MediaAsset> {
  assertPublishedVideoIsReady(file);
  const kind = file.kind as MediaAssetKind;
  const sourceContentHash = normalizeSha256Hash(file.contentHash);
  const sourceDuration = durationInProjectFrames(file, projectFps);
  const sourceRevision = createMediaSourceRevision({
    src: file.src,
    name: file.name,
    kind,
    sourceContentHash,
    sourceSize: file.size,
    sourceModifiedAt: file.sourceModifiedAt,
    durationInFrames: sourceDuration,
    width: file.width,
    height: file.height,
  });
  return {
    id: dependencies.createId ? dependencies.createId() : crypto.randomUUID(),
    name: file.name,
    sourceFilename: file.name,
    kind,
    src: file.src,
    durationInFrames: sourceDuration,
    sourceRevision,
    ...(sourceContentHash ? { sourceContentHash } : {}),
    sourceSize: file.size,
    sourceModifiedAt: file.sourceModifiedAt,
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
  };
}
