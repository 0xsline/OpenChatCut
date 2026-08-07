import type { MediaAsset, MediaAssetKind } from '../editor/types';
import { t } from '../i18n/locale';
import { putMediaBlob } from '../persist/mediaBlobStore';
import { extractAudioForAsr } from '../transcript/assemblyai';
import { extractAsrFromFile } from '../transcript/client-asr-extract';
import { kindOf, probeMediaFile, type MediaKind, type MediaMetadata } from './mediaProbe';
import { createMediaSourceRevision } from '../editor/mediaSourceRevision';
import { normalizeSha256Hash } from '../../shared/content-hash';
import {
  normalizeUploadedMediaLocation,
  type UploadedMediaLocation,
} from './uploadResponse';
import { uploadFile, type UploadProgress } from './uploadTransport';

export { kindOf } from './mediaProbe';
export type { MediaKind } from './mediaProbe';
export { isExpiredMultipartSessionError, retryExpiredMultipartSession } from './uploadTransport';
export type { UploadProgress } from './uploadTransport';

export interface ImportMediaHooks {
  onProgress?: UploadProgress;
  /**
   * Fired ASAP after metadata probe with a blob: URL so the pool/timeline can
   * preview while the multi-GB upload + optional normalize still runs.
   * Same asset id is reused when the server path is ready.
   */
  onPlaceholder?: (asset: MediaAsset) => void;
  /**
   * Fired as soon as master bytes hit /media/uploads — *before* video normalize.
   * Use to race-ahead extract-audio / ASR while normalize still runs.
   */
  onUploaded?: (info: {
    id: string;
    src: string;
    kind: MediaKind;
    sourceContentHash?: string;
    name: string;
    sourceRevision: string;
    sourceSize?: number;
    sourceModifiedAt?: number;
    /** Resolves to small ASR track path when extract succeeds (video/audio). */
    asrPath: Promise<string | null>;
  }) => void;
  /** Resolve authoritative imported bytes to an existing pool master, if one exists. */
  resolveCanonicalAsset?: (sourceContentHash: string, importingAssetId: string) => MediaAsset | undefined;
  /** Fired instead of onUploaded/onReady when an existing content-addressed master is reused. */
  onCanonical?: (asset: MediaAsset, duplicateAssetId: string) => void;
  /** Fired once server path (post-normalize) is ready — same id as placeholder. */
  onReady?: (asset: MediaAsset) => void;
}

function hooksOf(arg?: UploadProgress | ImportMediaHooks): ImportMediaHooks {
  if (!arg) return {};
  if (typeof arg === 'function') return { onProgress: arg };
  return arg;
}


export interface DesktopLocalMediaImport {
  src: string;
  storedName: string;
  contentHash?: string;
  proxyKind?: 'alpha-webm';
}

export interface DesktopLocalMediaApi {
  importLocalMedia?(file: File): Promise<DesktopLocalMediaImport | null>;
  prepareTransparentMovProxy?(storedName: string): Promise<{ src: string } | null>;
}

export interface DesktopLocalMediaTransfer {
  src: string;
  sourceContentHash?: string;
  desktopImport: DesktopLocalMediaImport | null;
}

type DesktopUploadFallback = (
  file: File,
  onProgress?: UploadProgress,
) => Promise<string | UploadedMediaLocation>;

async function importDesktopLocalMedia(
  file: File,
  api: DesktopLocalMediaApi | undefined,
): Promise<DesktopLocalMediaImport | null> {
  if (!api?.importLocalMedia) return null;
  const imported = await api.importLocalMedia(file);
  if (!imported) return null;
  if (!/\.mov$/i.test(imported.storedName) || !api.prepareTransparentMovProxy) return imported;
  const proxy = await api.prepareTransparentMovProxy(imported.storedName).catch(() => null);
  return proxy ? { ...imported, src: proxy.src, proxyKind: 'alpha-webm' } : imported;
}

/** Prefer the native desktop bridge; only absent/pathless bridges use HTTP. */
export async function transferDesktopLocalMedia(
  file: File,
  api: DesktopLocalMediaApi | undefined,
  uploadFallback: DesktopUploadFallback,
  onProgress?: UploadProgress,
): Promise<DesktopLocalMediaTransfer> {
  const desktopImport = await importDesktopLocalMedia(file, api);
  if (desktopImport) {
    const sourceContentHash = normalizeSha256Hash(desktopImport.contentHash);
    return {
      src: desktopImport.src,
      ...(sourceContentHash ? { sourceContentHash } : {}),
      desktopImport,
    };
  }
  const uploaded = normalizeUploadedMediaLocation(await uploadFallback(file, onProgress));
  return { ...uploaded, desktopImport: null };
}

export function shouldNormalizeImportedVideo(
  kind: MediaKind,
  desktopImport: DesktopLocalMediaImport | null,
): boolean {
  return kind === 'video' && desktopImport?.proxyKind !== 'alpha-webm';
}

type ImportUploadedInfo = Parameters<NonNullable<ImportMediaHooks['onUploaded']>>[0];

export interface ImportTranscriptionStart {
  asset: Pick<MediaAsset, 'id' | 'src' | 'kind' | 'sourceRevision' | 'sourceContentHash'> & { name?: string };
  asrPath: Promise<string | null>;
}

/**
 * New assets can start ASR from the uploaded master immediately. A replacement
 * must wait until its ready descriptor has relinked the existing master, so a
 * failed normalize cannot overwrite the old master's transcription state/job.
 */
export function createImportTranscriptionGate(relinkAssetId?: string) {
  let pending: ImportUploadedInfo | null = null;
  return {
    uploaded(info: ImportUploadedInfo): ImportTranscriptionStart | null {
      if (relinkAssetId) {
        pending = info;
        return null;
      }
      return { asset: info, asrPath: info.asrPath };
    },
    ready(asset: MediaAsset): ImportTranscriptionStart | null {
      if (!relinkAssetId || !pending) return null;
      const asrPath = pending.asrPath;
      pending = null;
      return { asset: { ...asset, id: relinkAssetId }, asrPath };
    },
  };
}

/**
 * Resolve clipboard snapshots against the live pool. A placeholder copied
 * during ingest becomes pasteable once its master is ready; until then its
 * short-lived blob URL is never persisted into a duplicate asset.
 */
export function readyMediaAssetsForPaste(
  copied: MediaAsset[],
  current: MediaAsset[],
): MediaAsset[] {
  const currentById = new Map(current.map((asset) => [asset.id, asset]));
  return copied
    .map((asset) => currentById.get(asset.id) ?? asset)
    .filter((asset) => !asset.src.startsWith('blob:'));
}

export function createMediaAssetsChatSeed(assets: MediaAsset[], nonce = Date.now()) {
  if (!assets.length) return null;
  return {
    text: `${assets.map((asset) => `@${asset.name}`).join(' ')} `,
    nonce,
    references: assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind })),
  };
}

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `a_${Date.now()}`;

/** Post-upload conditional compress (server ffmpeg). No-op for already-efficient sources. */
export async function normalizeUploadedVideo(
  src: string,
): Promise<{ src: string; width?: number; height?: number; durationSeconds?: number; fps?: number }> {
  try {
    const res = await fetch('/api/normalize-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    const data = (await res.json()) as {
      path?: string;
      width?: number;
      height?: number;
      durationSeconds?: number;
      fps?: number;
      normalized?: boolean;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.path?.startsWith('/media/uploads/')) {
      return {
        src: data.path,
        width: typeof data.width === 'number' ? data.width : undefined,
        height: typeof data.height === 'number' ? data.height : undefined,
        durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : undefined,
        fps: typeof data.fps === 'number' ? data.fps : undefined,
      };
    }
    throw new Error('server returned no media path');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(t('视频兼容性处理失败：{error}', { error: message }));
  }
}


interface PreparedMediaImport {
  file: File;
  fps: number;
  id: string;
  kind: MediaKind;
  sourceFilename: string;
  originalFilePath?: string;
  sourceSize: number;
  sourceModifiedAt: number;
  meta: MediaMetadata;
}

interface UploadedMediaImport extends DesktopLocalMediaTransfer {
  sourceRevision: string;
  asrPath: Promise<string | null>;
  canonicalAsset?: MediaAsset;
}

interface ReadyMediaSource {
  src: string;
  width?: number;
  height?: number;
  durationInFrames: number;
}

function originalPathOf(file: File): string | undefined {
  try {
    return typeof window === 'undefined'
      ? undefined
      : window.openChatCutDesktop?.getPathForFile(file);
  } catch {
    return undefined;
  }
}

async function prepareMediaImport(file: File, fps: number): Promise<PreparedMediaImport> {
  const kind = kindOf(file);
  if (!kind) throw new Error(t('不支持的文件类型（视频 / 图片 / 音频 / GIF / SVG）'));
  return {
    file,
    fps,
    id: newId(),
    kind,
    sourceFilename: file.name,
    originalFilePath: originalPathOf(file),
    sourceSize: file.size,
    sourceModifiedAt: file.lastModified,
    meta: await probeMediaFile(file, kind, fps),
  };
}

function placeholderAsset(prepared: PreparedMediaImport, blobUrl: string): MediaAsset {
  const { id, kind, meta, originalFilePath, sourceFilename, sourceModifiedAt, sourceSize } = prepared;
  return {
    id,
    name: sourceFilename,
    sourceFilename,
    originalFilePath,
    kind: kind as MediaAssetKind,
    src: blobUrl,
    durationInFrames: meta.durationInFrames,
    sourceRevision: createMediaSourceRevision({
      src: `file:${sourceFilename}`,
      name: sourceFilename,
      kind: kind as MediaAssetKind,
      sourceSize,
      sourceModifiedAt,
      durationInFrames: meta.durationInFrames,
      width: meta.width,
      height: meta.height,
    }),
    sourceSize,
    sourceModifiedAt,
    width: meta.width,
    height: meta.height,
  };
}

async function uploadPreparedMedia(
  prepared: PreparedMediaImport,
  hooks: ImportMediaHooks,
): Promise<UploadedMediaImport> {
  const { file, id, kind, meta, sourceFilename, sourceModifiedAt, sourceSize } = prepared;
  const transferred = await transferDesktopLocalMedia(
    file,
    (globalThis as typeof globalThis & { openChatCutDesktop?: DesktopLocalMediaApi }).openChatCutDesktop,
    uploadFile,
    hooks.onProgress ? (ratio) => hooks.onProgress!(ratio * 0.9) : undefined,
  );
  const sourceRevision = createMediaSourceRevision({
    src: transferred.src,
    name: sourceFilename,
    kind: kind as MediaAssetKind,
    sourceContentHash: transferred.sourceContentHash,
    sourceSize,
    sourceModifiedAt,
    durationInFrames: meta.durationInFrames,
    width: meta.width,
    height: meta.height,
  });
  hooks.onProgress?.(0.92);
  const canonicalAsset = transferred.sourceContentHash
    ? hooks.resolveCanonicalAsset?.(transferred.sourceContentHash, id)
    : undefined;
  if (canonicalAsset) {
    return {
      ...transferred,
      sourceRevision,
      canonicalAsset,
      asrPath: Promise.resolve(null),
    };
  }
  const clientAsr = kind === 'video' || kind === 'audio'
    ? extractAsrFromFile(file, kind).catch(() => null)
    : Promise.resolve(null);
  const asrPath = kind === 'video' || kind === 'audio'
    ? Promise.any([
      clientAsr.then((path) => { if (!path) throw new Error('client-asr-miss'); return path; }),
      extractAudioForAsr(transferred.src).then((path) => {
        if (!path) throw new Error('server-asr-miss');
        return path;
      }),
    ]).catch(() => null)
    : Promise.resolve(null);
  hooks.onUploaded?.({
    id, src: transferred.src, kind, name: sourceFilename,
    sourceRevision, sourceContentHash: transferred.sourceContentHash,
    sourceSize, sourceModifiedAt, asrPath,
  });
  return { ...transferred, sourceRevision, asrPath };
}

async function resolveReadySource(
  prepared: PreparedMediaImport,
  uploaded: UploadedMediaImport,
): Promise<ReadyMediaSource> {
  const { fps, kind, meta } = prepared;
  if (!shouldNormalizeImportedVideo(kind, uploaded.desktopImport)) {
    return {
      src: uploaded.src,
      width: meta.width,
      height: meta.height,
      durationInFrames: meta.durationInFrames,
    };
  }
  const normalized = await normalizeUploadedVideo(uploaded.src);
  return {
    src: normalized.src,
    width: normalized.width ?? meta.width,
    height: normalized.height ?? meta.height,
    durationInFrames: normalized.durationSeconds && normalized.durationSeconds > 0
      ? Math.max(1, Math.round(normalized.durationSeconds * fps))
      : meta.durationInFrames,
  };
}

function readyAsset(
  prepared: PreparedMediaImport,
  uploaded: UploadedMediaImport,
  readySource: ReadyMediaSource,
): MediaAsset {
  return {
    id: prepared.id,
    name: prepared.sourceFilename,
    sourceFilename: prepared.sourceFilename,
    originalFilePath: prepared.originalFilePath,
    kind: prepared.kind as MediaAssetKind,
    ...readySource,
    sourceRevision: uploaded.sourceRevision,
    sourceContentHash: uploaded.sourceContentHash,
    sourceSize: prepared.sourceSize,
    sourceModifiedAt: prepared.sourceModifiedAt,
  };
}

/** Probe, preview, stream-upload, normalize, then publish one stable source descriptor. */
export async function importMedia(
  file: File,
  fps: number,
  onProgressOrHooks?: UploadProgress | ImportMediaHooks,
): Promise<MediaAsset> {
  const hooks = hooksOf(onProgressOrHooks);
  const prepared = await prepareMediaImport(file, fps);
  const blobUrl = URL.createObjectURL(file);
  try {
    hooks.onPlaceholder?.(placeholderAsset(prepared, blobUrl));
    const uploaded = await uploadPreparedMedia(prepared, hooks);
    if (uploaded.canonicalAsset) {
      hooks.onProgress?.(1);
      hooks.onCanonical?.(uploaded.canonicalAsset, prepared.id);
      return uploaded.canonicalAsset;
    }
    const readySource = await resolveReadySource(prepared, uploaded);
    hooks.onProgress?.(1);
    if (readySource.src === uploaded.src && !uploaded.desktopImport) {
      void putMediaBlob(readySource.src, file, {
        name: prepared.sourceFilename,
        mime: file.type,
        sourceRevision: uploaded.sourceRevision,
        sourceSize: prepared.sourceSize,
        sourceModifiedAt: prepared.sourceModifiedAt,
      });
    }
    const ready = readyAsset(prepared, uploaded, readySource);
    (ready as MediaAsset & { __asrPath?: Promise<string | null> }).__asrPath = uploaded.asrPath;
    hooks.onReady?.(ready);
    return ready;
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
  }
}

/** Cache + optional re-publish helpers for callers that already have a public src. */
export { putMediaBlob, ensureMediaSrcs } from '../persist/mediaBlobStore';
