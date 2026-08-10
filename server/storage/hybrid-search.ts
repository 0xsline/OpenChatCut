// Hybrid search (phase C-3): fuse FTS5 text hits (chat/captions/transcripts)
// with sqlite-vec visual hits via Reciprocal Rank Fusion (RRF, k=60 — the
// standard constant). Both lanes run server-side in one call; the browser
// provides the query text embedding (the local model lives in the renderer).
import { searchContent } from './fulltext-search.ts';
import { searchSemanticVectors } from './semantic-vectors.ts';
import { sqliteStoreEnabled } from './sqlite-store.ts';

export interface HybridHit {
  kind: 'visual' | 'chat' | 'caption' | 'transcript';
  projectId: string;
  /** Text hits: index ref (chat:<project>:<msg> / project:<id>:captions|transcript). */
  ref?: string;
  /** Visual hits: asset id + frame time. */
  assetId?: string;
  sampleTime?: number;
  /** RRF fused score (larger = better). */
  score: number;
}

const RRF_K = 60;

function rrfFuse(
  lanes: Array<Array<{ id: string; hit: Omit<HybridHit, 'score'> }>>,
): HybridHit[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, Omit<HybridHit, 'score'>>();
  for (const lane of lanes) {
    lane.forEach((entry, index) => {
      const rank = index + 1;
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / (RRF_K + rank));
      if (!byId.has(entry.id)) byId.set(entry.id, entry.hit);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ ...byId.get(id)!, score }))
    .sort((left, right) => right.score - left.score);
}

export interface HybridSearchOptions {
  projectId?: string;
  limit?: number;
}

/**
 * Fuse text + visual lanes. The visual lane needs a project scope (vectors are
 * stored per project) and a query vector; without either it degrades to text
 * only. Returns [] when no lane is usable (e.g. store not migrated).
 */
export function hybridSearch(
  query: string,
  queryVector: number[] | undefined,
  options: HybridSearchOptions = {},
): HybridHit[] {
  if (!sqliteStoreEnabled()) return [];
  const bounded = Math.min(50, Math.max(1, Math.round(Number(options.limit) || 20)));
  const lanes: Array<Array<{ id: string; hit: Omit<HybridHit, 'score'> }>> = [];

  const textHits = searchContent(query, { projectId: options.projectId, limit: 50 });
  if (textHits.length > 0) {
    lanes.push(textHits.map((hit) => ({
      id: `text:${hit.kind}:${hit.ref}`,
      hit: {
        kind: hit.kind,
        projectId: hit.projectId,
        ref: hit.ref,
      },
    })));
  }

  if (options.projectId && queryVector && queryVector.length === 512) {
    const visualHits = searchSemanticVectors(options.projectId, queryVector, 50);
    if (visualHits.length > 0) {
      lanes.push(visualHits.map((hit) => ({
        id: `visual:${hit.assetId}:${hit.sampleTime}`,
        hit: {
          kind: 'visual',
          projectId: options.projectId!,
          assetId: hit.assetId,
          sampleTime: hit.sampleTime,
        },
      })));
    }
  }

  return rrfFuse(lanes).slice(0, bounded);
}
