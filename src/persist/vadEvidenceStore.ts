import { kvDel, kvGet, kvSet } from './sharedKv';

export interface VadTimeSpan {
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface VadEvidenceKey {
  assetId: string;
  sourceRevision: string;
  model: string;
  modelVersion: string;
  threshold: number;
}

export interface VadEvidence extends VadEvidenceKey {
  speechSpans: VadTimeSpan[];
  confidence: number;
  analyzedAt: number;
}

const queues = new Map<string, Promise<unknown>>();
const thresholdKey = (value: number): string => Math.max(0, Math.min(1, value)).toFixed(3);
const evidenceKey = (key: VadEvidenceKey): string => [
  'vad-evidence',
  encodeURIComponent(key.assetId),
  encodeURIComponent(key.sourceRevision),
  encodeURIComponent(key.model),
  encodeURIComponent(key.modelVersion),
  thresholdKey(key.threshold),
].join(':');

function serialize<T>(logicalKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(logicalKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(logicalKey, current);
  return current.finally(() => {
    if (queues.get(logicalKey) === current) queues.delete(logicalKey);
  });
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isVadEvidence(value: unknown, expected: VadEvidenceKey): value is VadEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VadEvidence>;
  return item.assetId === expected.assetId
    && item.sourceRevision === expected.sourceRevision
    && item.model === expected.model
    && item.modelVersion === expected.modelVersion
    && finite(item.threshold)
    && thresholdKey(item.threshold) === thresholdKey(expected.threshold)
    && finite(item.confidence)
    && item.confidence >= 0
    && item.confidence <= 1
    && finite(item.analyzedAt)
    && Array.isArray(item.speechSpans)
    && item.speechSpans.every((span) => finite(span?.startMs)
      && finite(span?.endMs)
      && finite(span?.confidence)
      && span.confidence >= 0
      && span.confidence <= 1
      && span.startMs >= 0
      && span.endMs > span.startMs);
}

export async function loadVadEvidence(key: VadEvidenceKey): Promise<VadEvidence | null> {
  try {
    const value = await kvGet<unknown>(evidenceKey(key));
    return isVadEvidence(value, key) ? value : null;
  } catch {
    return null;
  }
}

/** Only successful model evidence is cacheable. Unavailable/error fallbacks never become “no speech”. */
export function saveVadEvidence(evidence: VadEvidence): Promise<void> {
  const key = evidenceKey(evidence);
  return serialize(key, () => kvSet(key, {
    ...evidence,
    threshold: Number(thresholdKey(evidence.threshold)),
    speechSpans: evidence.speechSpans.map((span) => ({ ...span })),
  }));
}

export function clearVadEvidence(key: VadEvidenceKey): Promise<void> {
  const storageKey = evidenceKey(key);
  return serialize(storageKey, () => kvDel(storageKey));
}

export function resetVadEvidenceQueues(): void {
  queues.clear();
}
