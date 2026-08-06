import { kvDel, kvGet, kvSet } from './sharedKv';
import type { TranscriptionProviderId } from '../transcript/types';

export type TranscriptionProviderStatus =
  | 'preparing'
  | 'uploaded'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'stale';

export interface TranscriptionRetryMetadata {
  attempts: number;
  lastAttemptAt: number;
  lastError?: string;
  nextRetryAt?: number;
}

export interface TranscriptionCheckpoint {
  projectId: string;
  assetId: string;
  sourceRevision: string;
  provider: TranscriptionProviderId;
  providerJobId?: string;
  providerStatus: TranscriptionProviderStatus;
  uploadUrl?: string;
  languageCode: string;
  retry: TranscriptionRetryMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptionCheckpointKey {
  projectId: string;
  assetId: string;
  sourceRevision: string;
}

const queues = new Map<string, Promise<unknown>>();
const checkpointKey = (key: TranscriptionCheckpointKey): string => {
  if (!key.projectId) throw new Error('transcription checkpoint projectId is required');
  return `transcription-job:${encodeURIComponent(key.projectId)}:${encodeURIComponent(key.assetId)}:${encodeURIComponent(key.sourceRevision)}`;
};

function serialize<T>(logicalKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(logicalKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(logicalKey, current);
  return current.finally(() => {
    if (queues.get(logicalKey) === current) queues.delete(logicalKey);
  });
}

const statuses: ReadonlySet<TranscriptionProviderStatus> = new Set([
  'preparing', 'uploaded', 'submitted', 'processing', 'completed', 'failed', 'stale',
]);

function parseCheckpoint(value: unknown, expected: TranscriptionCheckpointKey): TranscriptionCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<TranscriptionCheckpoint>;
  if (item.projectId !== expected.projectId
    || item.assetId !== expected.assetId
    || item.sourceRevision !== expected.sourceRevision
    || (item.provider !== 'assemblyai' && item.provider !== 'local')
    || !statuses.has(item.providerStatus as TranscriptionProviderStatus)
    || typeof item.languageCode !== 'string'
    || !item.retry
    || !Number.isFinite(item.retry.attempts)
    || !Number.isFinite(item.retry.lastAttemptAt)
    || !Number.isFinite(item.createdAt)
    || !Number.isFinite(item.updatedAt)) return null;
  if (item.providerJobId !== undefined && typeof item.providerJobId !== 'string') return null;
  if (item.uploadUrl !== undefined && typeof item.uploadUrl !== 'string') return null;
  return item as TranscriptionCheckpoint;
}

async function loadByStorageKey(
  storageKey: string,
  expected: TranscriptionCheckpointKey,
): Promise<TranscriptionCheckpoint | null> {
  const value = await kvGet<unknown>(storageKey);
  return parseCheckpoint(value, expected);
}

export async function loadTranscriptionCheckpoint(
  key: TranscriptionCheckpointKey,
): Promise<TranscriptionCheckpoint | null> {
  try {
    return await loadByStorageKey(checkpointKey(key), key);
  } catch {
    return null;
  }
}

export function saveTranscriptionCheckpoint(checkpoint: TranscriptionCheckpoint): Promise<void> {
  const storageKey = checkpointKey(checkpoint);
  return serialize(storageKey, () => kvSet(storageKey, { ...checkpoint, retry: { ...checkpoint.retry } }));
}

export function updateTranscriptionCheckpoint(
  key: TranscriptionCheckpointKey,
  update: (current: TranscriptionCheckpoint | null) => TranscriptionCheckpoint,
): Promise<TranscriptionCheckpoint> {
  const storageKey = checkpointKey(key);
  return serialize(storageKey, async () => {
    const current = await loadByStorageKey(storageKey, key);
    const next = update(current);
    await kvSet(storageKey, { ...next, retry: { ...next.retry } });
    return next;
  });
}

export function clearTranscriptionCheckpoint(key: TranscriptionCheckpointKey): Promise<void> {
  const storageKey = checkpointKey(key);
  return serialize(storageKey, () => kvDel(storageKey));
}

export function resetTranscriptionCheckpointQueues(): void {
  queues.clear();
}
