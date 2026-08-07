import type { MediaAsset, TimelineItem } from './types.js';
import { timelineItemAssetId } from './mediaAssetUsage.js';
import { normalizeSha256Hash } from '../../shared/content-hash.js';

export type MediaSourceRevision = string;

export interface MediaSourceDescriptor {
  src: string;
  name?: string;
  kind?: MediaAsset['kind'];
  sourceSize?: number;
  sourceModifiedAt?: number;
  /** Imported master-byte hash; unchanged when `src` is a normalized/proxy derivative. */
  sourceContentHash?: string;
  durationInFrames?: number;
  width?: number;
  height?: number;
  code?: string;
  props?: Record<string, unknown>;
  sourceRevision?: MediaSourceRevision;
}

export interface DerivedArtifactKey {
  assetId: string;
  sourceRevision: MediaSourceRevision;
  artifactKind: string;
  algorithmVersion: string;
  policyHash?: string;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
    .join(',')}}`;
}

function finite(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash.toString(36).padStart(7, '0');
}

/**
 * Deterministic identity for the bytes or source representation behind an asset.
 * File-backed imports prefer a validated SHA-256 identity. Legacy documents and
 * non-file representations fall back to their stable persisted metadata.
 */
export function createMediaSourceRevision(source: MediaSourceDescriptor): MediaSourceRevision {
  const contentHash = normalizeSha256Hash(source.sourceContentHash);
  if (contentHash) return `source-sha256-${contentHash}`;
  const identity = [
    source.src,
    source.name ?? '',
    source.kind ?? '',
    finite(source.sourceSize),
    finite(source.sourceModifiedAt),
    finite(source.durationInFrames),
    finite(source.width),
    finite(source.height),
    source.code ?? '',
    source.props === undefined ? '' : stableValue(source.props),
  ].join('\u0000');
  return `source-v1-${hash32(identity, 0x811c9dc5)}${hash32(identity, 0x9e3779b9)}`;
}

/** A validated content hash wins; persisted revisions are fallback identity for legacy sources. */
export function sourceRevisionOf(source: MediaSourceDescriptor): MediaSourceRevision {
  const contentHash = normalizeSha256Hash(source.sourceContentHash);
  if (contentHash) return createMediaSourceRevision({ ...source, sourceContentHash: contentHash });
  return typeof source.sourceRevision === 'string' && source.sourceRevision.length > 0
    ? source.sourceRevision
    : createMediaSourceRevision(source);
}

export function withMediaSourceRevision<T extends MediaSourceDescriptor>(
  source: T,
): Omit<T, 'sourceRevision' | 'sourceContentHash'> & {
  sourceContentHash?: string;
  sourceRevision: MediaSourceRevision;
} {
  const sourceContentHash = normalizeSha256Hash(source.sourceContentHash);
  const { sourceRevision: _sourceRevision, sourceContentHash: _rawContentHash, ...rest } = source;
  return {
    ...rest,
    ...(sourceContentHash ? { sourceContentHash } : {}),
    sourceRevision: sourceRevisionOf({ ...source, sourceContentHash }),
  };
}


export interface TimelineItemSourceSnapshot {
  itemId: string;
  kind: TimelineItem['kind'];
  src: string;
  sourceRevision: MediaSourceRevision;
  sourceContentHash?: string;
}

export type TimelineItemSourceStaleReason =
  | 'item_missing'
  | 'item_identity_changed'
  | 'item_kind_changed'
  | 'item_source_changed'
  | 'source_revision_changed'
  | 'result_revision_mismatch';

export interface TimelineItemSourceCurrent {
  status: 'current';
  currentSourceRevision: MediaSourceRevision;
}

export interface TimelineItemSourceStale {
  status: 'stale';
  itemId: string;
  reason: TimelineItemSourceStaleReason;
  sourceRevision: MediaSourceRevision;
  currentSourceRevision: MediaSourceRevision | null;
  resultSourceRevision: MediaSourceRevision | null;
}

export type TimelineItemSourceValidation = TimelineItemSourceCurrent | TimelineItemSourceStale;

export type TimelineItemSourceBatchValidation =
  | { status: 'current' }
  | { status: 'stale'; staleItems: TimelineItemSourceStale[] };

export interface TimelineItemSourceResult {
  sourceRevision: MediaSourceRevision;
}

export function sourceRevisionForTimelineItem(
  item: TimelineItem,
  assets: readonly MediaAsset[],
): MediaSourceRevision {
  const src = item.src ?? '';
  const sourceAssetId = timelineItemAssetId(item, assets);
  const sourceAsset = sourceAssetId
    ? assets.find((asset) => asset.id === sourceAssetId)
    : assets.find((asset) => asset.src === src);
  const mediaKind = item.kind === 'text' || item.kind === 'solid' || item.kind === 'sequence'
    ? undefined
    : item.kind;
  return sourceRevisionOf(sourceAsset ?? {
    src,
    name: item.name,
    kind: mediaKind,
    sourceRevision: item.sourceRevision,
    sourceContentHash: item.sourceContentHash,
    durationInFrames: item.durationInFrames,
    width: item.width,
    height: item.height,
    code: item.code,
    props: item.props,
  });
}

export function sourceContentHashForTimelineItem(
  item: TimelineItem,
  assets: readonly MediaAsset[],
): string | undefined {
  const assetId = timelineItemAssetId(item, assets);
  const asset = assetId
    ? assets.find((candidate) => candidate.id === assetId)
    : assets.find((candidate) => candidate.src === item.src);
  return normalizeSha256Hash(asset?.sourceContentHash ?? item.sourceContentHash);
}

export function captureTimelineItemSource(
  item: TimelineItem,
  assets: readonly MediaAsset[],
): TimelineItemSourceSnapshot {
  return {
    itemId: item.id,
    kind: item.kind,
    src: item.src ?? '',
    sourceRevision: sourceRevisionForTimelineItem(item, assets),
    sourceContentHash: sourceContentHashForTimelineItem(item, assets),
  };
}

export function validateTimelineItemSourceResult(
  snapshot: TimelineItemSourceSnapshot,
  currentItem: TimelineItem | null | undefined,
  assets: readonly MediaAsset[],
  resultSourceRevision: MediaSourceRevision | null | undefined,
): TimelineItemSourceValidation {
  const currentSourceRevision = currentItem
    ? sourceRevisionForTimelineItem(currentItem, assets)
    : null;
  const reason = !currentItem
    ? 'item_missing'
    : currentItem.id !== snapshot.itemId
      ? 'item_identity_changed'
      : currentItem.kind !== snapshot.kind
        ? 'item_kind_changed'
        : (currentItem.src ?? '') !== snapshot.src
          ? 'item_source_changed'
          : currentSourceRevision !== snapshot.sourceRevision
            ? 'source_revision_changed'
            : resultSourceRevision !== snapshot.sourceRevision
              ? 'result_revision_mismatch'
              : null;
  if (reason) {
    return {
      status: 'stale',
      itemId: snapshot.itemId,
      reason,
      sourceRevision: snapshot.sourceRevision,
      currentSourceRevision,
      resultSourceRevision: resultSourceRevision ?? null,
    };
  }
  return { status: 'current', currentSourceRevision: currentSourceRevision! };
}

export function validateTimelineItemSourceBatch(
  snapshots: readonly TimelineItemSourceSnapshot[],
  currentItems: readonly TimelineItem[],
  assets: readonly MediaAsset[],
  resultById: ReadonlyMap<string, TimelineItemSourceResult>,
): TimelineItemSourceBatchValidation {
  const currentById = new Map<string, TimelineItem>();
  for (const item of currentItems) currentById.set(item.id, item);
  const staleItems: TimelineItemSourceStale[] = [];
  for (const snapshot of snapshots) {
    const validation = validateTimelineItemSourceResult(
      snapshot,
      currentById.get(snapshot.itemId),
      assets,
      resultById.get(snapshot.itemId)?.sourceRevision,
    );
    if (validation.status === 'stale') staleItems.push(validation);
  }
  return staleItems.length
    ? { status: 'stale', staleItems }
    : { status: 'current' };
}

/**
 * Relinking is an explicit source replacement. When sparse metadata happens to
 * fingerprint identically (for example the same path was overwritten), advance
 * from the prior revision so old asynchronous work is still invalidated.
 */
export function revisionAfterRelink(
  previous: MediaSourceDescriptor,
  replacement: MediaSourceDescriptor,
): MediaSourceRevision {
  const prior = sourceRevisionOf(previous);
  const candidate = sourceRevisionOf(replacement);
  if (candidate !== prior) return candidate;
  // Progressive local ingest swaps its blob preview for the uploaded path while
  // keeping the same source bytes and revision.
  if (previous.src.startsWith('blob:') && !replacement.src.startsWith('blob:')) return prior;
  return createMediaSourceRevision({
    ...replacement,
    sourceRevision: undefined,
    src: `${replacement.src}\u0000relink-from:${prior}`,
  });
}

export type DerivedArtifactCommit<T> =
  | { status: 'committed'; value: T }
  | { status: 'stale' };

/**
 * Final write barrier for a long-running derivative. The key is captured when
 * work starts; the writer is never invoked after relink/replacement changes the
 * asset revision.
 */
export async function commitDerivedArtifactIfCurrent<T>(
  key: DerivedArtifactKey,
  currentAsset: () => MediaSourceDescriptor & { id: string } | null | undefined,
  commit: (key: DerivedArtifactKey) => T | Promise<T>,
): Promise<DerivedArtifactCommit<T>> {
  const current = currentAsset();
  if (!current || current.id !== key.assetId || sourceRevisionOf(current) !== key.sourceRevision) {
    return { status: 'stale' };
  }
  return { status: 'committed', value: await commit(key) };
}
