import type { MediaAsset } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { sha256Text } from '../../persist/agentRuntimeStore';
import {
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
} from '../../persist/projectStoreTransport';
import {
  MUSIC_ANALYSIS_SCHEMA_VERSION,
  MUSIC_ANALYZER_FINGERPRINT,
  MUSIC_MODEL_PACK_FINGERPRINTS,
} from './types';
import type { MusicAnalysis, MusicSection, MusicTag } from './types';

const DATABASE_NAME = 'openchatcut-music-intelligence';
const DATABASE_VERSION = 1;
const STORE_NAME = 'analysis-v1';
/** Server-side kv prefix (phase B: analysis survives cache wipes). */
const REMOTE_PREFIX = 'music-analysis:';
const memory = new Map<string, unknown>();
const TAG_KINDS: Record<MusicTag['kind'], true> = {
  genre: true,
  mood: true,
  instrument: true,
  usage: true,
};
const SECTION_ROLES: Record<MusicSection['role'], true> = {
  'intro-like': true,
  build: true,
  peak: true,
  break: true,
  steady: true,
  'outro-like': true,
};

interface StoredAnalysis {
  key: string;
  analyzerFingerprint: string;
  analysis: MusicAnalysis;
}

interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

const promiseConstructor = Promise as unknown as {
  withResolvers<T>(): PromiseResolvers<T>;
};
const inRange = (value: unknown, low: number, high: number): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
);

function cacheKey(assetId: string, sourceRevision: string): string {
  return JSON.stringify([assetId, sourceRevision, MUSIC_ANALYZER_FINGERPRINT]);
}

/** URL-safe server key: cacheKey contains JSON punctuation, hash it. */
async function remoteKey(cacheKeyValue: string): Promise<string> {
  return `${REMOTE_PREFIX}${await sha256Text(cacheKeyValue)}`;
}

function validTimes(value: unknown, durationMs: number): value is number[] {
  if (!Array.isArray(value) || value.length > 1_000_000) return false;
  let previous = -1;
  for (const time of value) {
    if (!inRange(time, 0, durationMs) || time <= previous) return false;
    previous = time;
  }
  return true;
}

function validEmbedding(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== 512) return false;
  let squaredNorm = 0;
  for (const component of value) {
    if (!inRange(component, -1, 1)) return false;
    squaredNorm += component * component;
  }
  const norm = Math.sqrt(squaredNorm);
  return norm >= 0.98 && norm <= 1.02;
}

function validTag(value: unknown): value is MusicTag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const tag = value as Partial<Record<keyof MusicTag, unknown>>;
  return typeof tag.kind === 'string'
    && Object.hasOwn(TAG_KINDS, tag.kind)
    && typeof tag.label === 'string'
    && tag.label.length > 0
    && tag.label.trim() === tag.label
    && tag.label.length <= 120
    && inRange(tag.score, 0, 1);
}

function validTags(value: unknown): value is MusicTag[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  for (const tag of value) if (!validTag(tag)) return false;
  return true;
}

function validSection(value: unknown, durationMs: number): value is MusicSection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const section = value as Partial<Record<keyof MusicSection, unknown>>;
  return inRange(section.fromMs, 0, durationMs)
    && inRange(section.toMs, 0, durationMs)
    && section.toMs > section.fromMs
    && typeof section.role === 'string'
    && Object.hasOwn(SECTION_ROLES, section.role)
    && inRange(section.energy, 0, 1)
    && inRange(section.boundaryConfidence, 0, 1);
}

function validSections(value: unknown, durationMs: number): value is MusicSection[] {
  if (!Array.isArray(value) || value.length > 128) return false;
  let previousEnd = 0;
  for (const section of value) {
    if (!validSection(section, durationMs) || section.fromMs !== previousEnd) return false;
    previousEnd = section.toMs;
  }
  return value.length === 0 ? durationMs === 0 : previousEnd === Math.round(durationMs);
}

function validIdentity(value: Partial<Record<keyof MusicAnalysis, unknown>>, assetId?: string, sourceRevision?: string): boolean {
  return value.schemaVersion === MUSIC_ANALYSIS_SCHEMA_VERSION
    && typeof value.assetId === 'string'
    && value.assetId.length > 0
    && value.assetId.length <= 512
    && (!assetId || value.assetId === assetId)
    && typeof value.sourceRevision === 'string'
    && value.sourceRevision.length > 0
    && value.sourceRevision.length <= 512
    && (!sourceRevision || value.sourceRevision === sourceRevision)
    && inRange(value.createdAt, 0, Number.MAX_SAFE_INTEGER);
}

function validModels(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const models = value as Partial<MusicAnalysis['modelPacks']>;
  return models.rhythm === MUSIC_MODEL_PACK_FINGERPRINTS.rhythm
    && models.semantic === MUSIC_MODEL_PACK_FINGERPRINTS.semantic;
}

export function isMusicAnalysis(value: unknown, assetId?: string, sourceRevision?: string): value is MusicAnalysis {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const analysis = value as Partial<Record<keyof MusicAnalysis, unknown>>;
  if (!validIdentity(analysis, assetId, sourceRevision)) return false;
  if (!inRange(analysis.durationMs, 0, Number.MAX_SAFE_INTEGER) || !validModels(analysis.modelPacks)) return false;
  if (!inRange(analysis.bpm, 0, 400) || !inRange(analysis.meter, 1, 16) || !Number.isInteger(analysis.meter)) return false;
  return inRange(analysis.beatConfidence, 0, 1)
    && validTimes(analysis.beatsMs, analysis.durationMs)
    && validTimes(analysis.downbeatsMs, analysis.durationMs)
    && validSections(analysis.sections, analysis.durationMs)
    && validTags(analysis.tags)
    && validEmbedding(analysis.embedding);
}

function validStored(value: unknown, key: string, assetId: string, sourceRevision: string): value is StoredAnalysis {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const stored = value as Partial<Record<keyof StoredAnalysis, unknown>>;
  return stored.key === key
    && stored.analyzerFingerprint === MUSIC_ANALYZER_FINGERPRINT
    && isMusicAnalysis(stored.analysis, assetId, sourceRevision);
}

function openDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = promiseConstructor.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Unable to open music analysis cache'));
  return promise;
}

async function idbRead(key: string): Promise<unknown> {
  const database = await openDatabase();
  try {
    const { promise, resolve, reject } = promiseConstructor.withResolvers<unknown>();
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as unknown);
    request.onerror = () => reject(request.error ?? new Error('Unable to read music analysis cache'));
    return await promise;
  } finally {
    database.close();
  }
}

async function idbWrite(value: StoredAnalysis): Promise<void> {
  const database = await openDatabase();
  try {
    const { promise, resolve, reject } = promiseConstructor.withResolvers<void>();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value);
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to write music analysis cache'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Music analysis cache write aborted'));
    await promise;
  } finally {
    database.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const database = await openDatabase();
  try {
    const { promise, resolve } = promiseConstructor.withResolvers<void>();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => resolve(undefined);
    transaction.onabort = () => resolve(undefined);
    await promise;
  } finally {
    database.close();
  }
}

export async function loadMusicAnalysisForAsset(asset: MediaAsset): Promise<MusicAnalysis | null> {
  const sourceRevision = sourceRevisionOf(asset);
  const key = cacheKey(asset.id, sourceRevision);
  let stored = memory.get(key);
  // Phase B: the server (SQLite after migration) is the primary cache once
  // reachable; IndexedDB remains the offline/static-deploy fallback.
  if (stored === undefined && projectStoreRemoteAvailable()) {
    try {
      const response = await requestProjectStore({ operation: 'entry', key: await remoteKey(key) });
      const row = response as { found: boolean; value?: unknown };
      if (row.found) stored = row.value;
    } catch {
      stored = undefined;
    }
  }
  if (stored === undefined && typeof indexedDB !== 'undefined') {
    try { stored = await idbRead(key); } catch { stored = undefined; }
  }
  if (!validStored(stored, key, asset.id, sourceRevision)) {
    memory.delete(key);
    if (stored !== undefined && typeof indexedDB !== 'undefined') void idbDelete(key).catch(() => undefined);
    if (stored !== undefined && projectStoreWriteCredential()) {
      // Drop the invalid remote copy too, so it does not shadow fresh results.
      void requestProjectStore({ operation: 'delete', key: await remoteKey(key) }).catch(() => undefined);
    }
    return null;
  }
  memory.set(key, stored);
  return stored.analysis;
}

export async function saveMusicAnalysis(analysis: MusicAnalysis): Promise<void> {
  if (!isMusicAnalysis(analysis)) throw new Error('Refusing to cache invalid music analysis');
  const key = cacheKey(analysis.assetId, analysis.sourceRevision);
  const stored: StoredAnalysis = { key, analyzerFingerprint: MUSIC_ANALYZER_FINGERPRINT, analysis };
  memory.set(key, stored);
  if (projectStoreWriteCredential()) {
    try {
      await requestProjectStore({ operation: 'set', key: await remoteKey(key), value: stored });
      return; // server is authoritative once reachable
    } catch {
      // fall through to the local cache
    }
  }
  if (typeof indexedDB !== 'undefined') {
    try { await idbWrite(stored); } catch { /* derived cache remains best-effort */ }
  }
}

function referenceDigest(analysis: MusicAnalysis): string {
  const content = JSON.stringify([
    analysis.createdAt,
    analysis.durationMs,
    analysis.bpm,
    analysis.meter,
    analysis.beatConfidence,
    analysis.beatsMs,
    analysis.downbeatsMs,
    analysis.sections,
    analysis.tags,
  ]);
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function musicAnalysisRef(analysis: MusicAnalysis): string {
  if (!isMusicAnalysis(analysis)) throw new Error('Cannot reference invalid music analysis');
  const identity = [
    encodeURIComponent(analysis.assetId),
    encodeURIComponent(analysis.sourceRevision),
    encodeURIComponent(MUSIC_ANALYZER_FINGERPRINT),
    referenceDigest(analysis),
  ];
  return `music-analysis:v2:${identity.join(':')}`;
}
