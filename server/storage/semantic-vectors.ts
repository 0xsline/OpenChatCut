// Semantic vectors via sqlite-vec (phase C): vec0 virtual table with metadata
// columns for scope/asset/source filtering. Server-side TopK search replaces
// the browser-side full-scope ranking once the project store is on SQLite.
//
// The extension is loaded lazily; any load failure degrades to "unavailable"
// (the browser keeps its IndexedDB + local-ranking fallback).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load as sqliteVecLoad } from 'sqlite-vec';
import { SEMANTIC_INFERENCE_CONTRACT } from '../../shared/vector-inference-contract.ts';
import { sqliteStoreEnabled, storePath } from './sqlite-store.ts';

const VEC_TABLE = 'semantic_vectors';
const VEC_DIMENSION = SEMANTIC_INFERENCE_CONTRACT.embeddingDimension;
const MODEL_VERSION = SEMANTIC_INFERENCE_CONTRACT.id;

export interface SemanticVectorSample {
  assetId: string;
  sampleTime: number;
  sourceRevision?: string;
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
  vector: number[];
}

export interface SemanticVectorHit {
  assetId: string;
  sampleTime: number;
  sourceRevision?: string | null;
  sceneId?: string | null;
  sceneStart?: number | null;
  sceneEnd?: number | null;
  distance: number;
}

export interface PruneSemanticResult {
  staleModelRemoved: boolean;
  staleSourceRemoved: boolean;
}

let connection: DatabaseSync | null = null;
let extensionFailed = false;

/** Whether server-side semantic vectors are usable right now (lazy init). */
export function semanticVectorsAvailable(): boolean {
  return openConnection() !== null;
}

function openConnection(): DatabaseSync | null {
  if (connection) return connection;
  if (extensionFailed || !sqliteStoreEnabled()) return null;
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path, { allowExtension: true });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    sqliteVecLoad(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
      embedding float[${VEC_DIMENSION}], scope_id text, asset_id text, sample_time float,
      source_revision text, scene_id text, scene_start float, scene_end float, model_version text
    )`);
    connection = db;
    return db;
  } catch {
    // Extension missing / unsupported platform → degrade to browser-side index.
    extensionFailed = true;
    return null;
  }
}

/** Close the connection (verify isolation / profile switches). */
export function resetSemanticVectorsForTests(): void {
  connection?.close();
  connection = null;
  extensionFailed = false;
}

function requireConnection(): DatabaseSync {
  const db = openConnection();
  if (!db) throw new Error('semantic vectors unavailable');
  return db;
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === VEC_DIMENSION
    && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

function validAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
}

/** Replace one asset's samples in one transaction (delete-then-insert). */
export function upsertSemanticVectors(
  scopeId: string,
  assetId: string,
  samples: SemanticVectorSample[],
): { inserted: number } {
  if (!validAssetId(scopeId) || !validAssetId(assetId)) throw new Error('invalid semantic vector scope/asset id');
  if (!Array.isArray(samples) || samples.length > 512) throw new Error('invalid semantic vector batch');
  for (const sample of samples) {
    if (!validAssetId(sample.assetId) || !validVector(sample.vector)) {
      throw new Error('invalid semantic vector sample');
    }
  }
  const db = requireConnection();
  const insert = db.prepare(`INSERT INTO ${VEC_TABLE}
    (embedding, scope_id, asset_id, sample_time, source_revision, scene_id, scene_start, scene_end, model_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ${VEC_TABLE} WHERE scope_id = ? AND asset_id = ?`).run(scopeId, assetId);
    for (const sample of samples) {
      // vec0 metadata columns do not accept NULL: use explicit defaults.
      insert.run(
        new Float32Array(sample.vector),
        scopeId,
        sample.assetId,
        sample.sampleTime,
        sample.sourceRevision ?? 'legacy',
        sample.sceneId ?? '',
        sample.sceneStart ?? -1,
        sample.sceneEnd ?? -1,
        MODEL_VERSION,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { inserted: samples.length };
}

/** Server-side TopK search (L2 on normalized vectors ≈ cosine ranking). */
export function searchSemanticVectors(
  scopeId: string,
  queryVector: number[],
  limit: number,
): SemanticVectorHit[] {
  if (!validAssetId(scopeId) || !validVector(queryVector)) throw new Error('invalid semantic search input');
  const bounded = Math.min(100, Math.max(1, Math.round(Number(limit) || 24)));
  const db = requireConnection();
  const rows = db.prepare(`SELECT asset_id, sample_time, source_revision, scene_id, scene_start, scene_end, distance
    FROM ${VEC_TABLE}
    WHERE scope_id = ? AND model_version = ? AND embedding MATCH ?
    ORDER BY distance ASC LIMIT ?`).all(scopeId, MODEL_VERSION, new Float32Array(queryVector), bounded) as Array<{
      asset_id: string;
      sample_time: number;
      source_revision: string | null;
      scene_id: string | null;
      scene_start: number | null;
      scene_end: number | null;
      distance: number;
    }>;
  return rows.map((row) => ({
    assetId: row.asset_id,
    sampleTime: row.sample_time,
    sourceRevision: row.source_revision,
    sceneId: row.scene_id,
    sceneStart: row.scene_start,
    sceneEnd: row.scene_end,
    distance: row.distance,
  }));
}

/** Remove stale rows (model change / asset gone / source revision changed). */
export function pruneSemanticVectors(
  scopeId: string,
  validAssetIds: string[],
  validSourceRevisions?: ReadonlyMap<string, string>,
): PruneSemanticResult {
  if (!validAssetId(scopeId)) throw new Error('invalid semantic vector scope id');
  const db = requireConnection();
  const rows = db.prepare(`SELECT rowid, asset_id, source_revision, model_version
    FROM ${VEC_TABLE} WHERE scope_id = ?`).all(scopeId) as Array<{
      rowid: number;
      asset_id: string;
      source_revision: string | null;
      model_version: string;
    }>;
  const valid = new Set(validAssetIds);
  let staleModelRemoved = false;
  let staleSourceRemoved = false;
  const remove = db.prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid = ?`);
  for (const row of rows) {
    if (row.model_version !== MODEL_VERSION) {
      staleModelRemoved = true;
      remove.run(row.rowid);
      continue;
    }
    if (!valid.has(row.asset_id)) {
      remove.run(row.rowid);
      continue;
    }
    if (validSourceRevisions && row.source_revision !== validSourceRevisions.get(row.asset_id)) {
      staleSourceRemoved = true;
      remove.run(row.rowid);
    }
  }
  return { staleModelRemoved, staleSourceRemoved };
}

/** Remove every vector of a scope. */
export function clearSemanticVectors(scopeId: string): void {
  if (!validAssetId(scopeId)) throw new Error('invalid semantic vector scope id');
  requireConnection().prepare(`DELETE FROM ${VEC_TABLE} WHERE scope_id = ?`).run(scopeId);
}
