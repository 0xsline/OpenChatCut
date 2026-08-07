/**
 * Visual-geometry analysis: sample the asset's frames (reusing the semantic
 * search sampler), run MediaPipe person segmentation + face detection, and
 * aggregate per-segment safe zones.
 *
 * Everything here is browser-only (MediaPipe + canvas). Results are cached in
 * IndexedDB keyed by assetId + sourceRevision + algorithmVersion — derived
 * artifact, never part of the project document (no schema migration).
 */

import type { MediaAsset } from '../editor/types';
import { sourceRevisionOf } from '../editor/mediaSourceRevision';
import { safeZoneForRange, type FrameGeom, type GeomRect, type SafeZone } from './geometry-math';
import {
  GEOM_MAX_FRAMES,
  getMediaPipeRuntime,
  inferFrameFromPixels,
} from './mediapipe';
import { sampleGeometryFrames } from './sample';

export const GEOMETRY_ALGORITHM_VERSION = 'mediapipe-v2';

/** Bottom caption-reserve band subtracted from every safe zone (hard no-go). */
export const CAPTION_RESERVE = 0.16;
/** Minimum segment length in seconds for a safe zone to be computed. */
const MIN_SEGMENT_SEC = 0.4;
const GEOMETRY_ANALYSIS_TIMEOUT_MS = 120_000;

export type PersonSide = 'left' | 'center' | 'right' | 'none';

export interface VisualSegment {
  /** Source-seconds range (relative to the asset). */
  startSec: number;
  endSec: number;
  zone: SafeZone;
  /** Which side of the frame the person occupies (framing direction). */
  person: PersonSide;
}

export interface VisualGeometryAsset {
  assetId: string;
  sourceRevision: string;
  algorithmVersion: string;
  durationSec: number;
  segments: VisualSegment[];
}

/** Person bbox → side of frame (subject center <0.4 left, >0.6 right). */
export function personFromSubject(subject: GeomRect | null): PersonSide {
  if (!subject || subject.w * subject.h < 0.02) return 'none';
  const cx = subject.x + subject.w / 2;
  return cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'center';
}

/** Split sampled frames into source segments by their scene boundaries; frames
 * without scene metadata fall back to uniform buckets (≤12 per asset). */
export function segmentBoundaries(
  frames: readonly { sampleTime: number; sceneStart?: number; sceneEnd?: number }[],
  durationSec: number,
): { startSec: number; endSec: number }[] {
  const scenes = new Map<number, { start: number; end: number }>();
  for (const f of frames) {
    if (typeof f.sceneStart === 'number' && typeof f.sceneEnd === 'number') {
      const existing = scenes.get(f.sceneStart);
      if (!existing || f.sceneEnd > existing.end) scenes.set(f.sceneStart, { start: f.sceneStart, end: f.sceneEnd });
    }
  }
  if (scenes.size) {
    return [...scenes.values()]
      .sort((a, b) => a.start - b.start)
      .filter((s) => s.end - s.start >= MIN_SEGMENT_SEC)
      .map((s) => ({ startSec: Math.max(0, s.start), endSec: Math.min(durationSec, s.end) }));
  }
  const buckets = 12;
  const step = Math.max(MIN_SEGMENT_SEC, durationSec / buckets);
  const out: { startSec: number; endSec: number }[] = [];
  for (let start = 0; start < durationSec - 1e-6; start += step) {
    out.push({ startSec: start, endSec: Math.min(durationSec, start + step) });
  }
  return out;
}

export interface AnalyzeResult {
  geometry: VisualGeometryAsset | null;
  reason?: 'cached' | 'computed' | 'unavailable' | 'empty';
}

const CAPTION_BAND: GeomRect = { x: 0, y: 1 - CAPTION_RESERVE, w: 1, h: CAPTION_RESERVE };

async function computeGeometry(
  asset: MediaAsset,
  signal: AbortSignal,
  maxSamples: number,
): Promise<VisualGeometryAsset | null> {
  const runtime = await getMediaPipeRuntime(signal);
  if (!runtime) return null;
  const frames: FrameGeom[] = [];
  const samples: Array<{
    sampleTime: number;
    sceneStart?: number;
    sceneEnd?: number;
  }> = [];
  let durationSec = 0;
  for await (const sample of sampleGeometryFrames(asset, signal, maxSamples)) {
    signal.throwIfAborted();
    const { face, occ } = inferFrameFromPixels(runtime, sample);
    frames.push({ t: sample.sampleTime, face, occ });
    samples.push({
      sampleTime: sample.sampleTime,
      sceneStart: sample.sceneStart,
      sceneEnd: sample.sceneEnd,
    });
    durationSec = sample.durationSec;
  }
  if (!frames.length || !(durationSec > 0)) return null;
  const boundaries = segmentBoundaries(samples, durationSec);
  const segments: VisualSegment[] = boundaries
    .map((boundary) => {
      const zone = safeZoneForRange(
        frames,
        boundary.startSec,
        boundary.endSec,
        [CAPTION_BAND],
      );
      return { ...boundary, zone, person: personFromSubject(zone.subject) };
    })
    .filter((segment) => segment.zone.rects.length > 0 || segment.zone.subject !== null);
  if (!segments.length) return null;
  return {
    assetId: asset.id,
    sourceRevision: sourceRevisionOf(asset),
    algorithmVersion: GEOMETRY_ALGORITHM_VERSION,
    durationSec,
    segments,
  };
}

// ── IndexedDB cache (mirrors the semantic-vector store pattern) ──────────────

const DB_NAME = 'openchatcut-geometry';
const STORE_NAME = 'zones';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCached(key: string): Promise<VisualGeometryAsset | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const value = req.result as { frames?: unknown[]; segments?: VisualSegment[]; durationSec?: number; assetId?: string; sourceRevision?: string; algorithmVersion?: string } | undefined;
        resolve(value ? (value as VisualGeometryAsset) : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeCached(key: string, geometry: VisualGeometryAsset): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(geometry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* cache is best-effort */
  }
}

function cacheKey(asset: MediaAsset): string {
  return `${asset.id}:${sourceRevisionOf(asset)}:${GEOMETRY_ALGORITHM_VERSION}`;
}


export interface AnalyzeGeometryOptions {
  /** Bound uncached decoding/inference work; reduced runs are not persisted. */
  maxSamples?: number;
}
/** Analyze (or read from cache) the visual geometry of an asset. Never throws. */
export async function analyzeAssetGeometry(
  asset: MediaAsset,
  signal?: AbortSignal,
  options: AnalyzeGeometryOptions = {},
): Promise<AnalyzeResult> {
  if (asset.kind !== 'video' && asset.kind !== 'gif') {
    return { geometry: null, reason: 'unavailable' };
  }
  if (!asset.src || asset.src.startsWith('blob:') || asset.src.startsWith('data:')) {
    return { geometry: null, reason: 'unavailable' };
  }
  const key = cacheKey(asset);
  const cached = await readCached(key);
  if (cached) return { geometry: cached, reason: 'cached' };
  const requestedSamples = Number.isFinite(options.maxSamples)
    ? Math.floor(options.maxSamples!)
    : GEOM_MAX_FRAMES;
  const maxSamples = Math.max(1, Math.min(GEOM_MAX_FRAMES, requestedSamples));
  const timeoutSignal = AbortSignal.timeout(GEOMETRY_ANALYSIS_TIMEOUT_MS);
  const analysisSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const geometry = await computeGeometry(asset, analysisSignal, maxSamples);
    if (!geometry) return { geometry: null, reason: 'empty' };
    if (maxSamples === GEOM_MAX_FRAMES) await writeCached(key, geometry);
    return { geometry, reason: 'computed' };
  } catch {
    return { geometry: null, reason: 'unavailable' };
  }
}

/** Drop a cached geometry for one asset (e.g. after a failed partial analysis). */
export async function clearAssetGeometry(assetId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const value = cursor.value as VisualGeometryAsset | undefined;
          if (value?.assetId === assetId) cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}

