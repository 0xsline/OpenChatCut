import type { MediaAsset } from '../editor/types';
import { sourceRevisionOf } from '../editor/mediaSourceRevision';
import type { SemanticMatch } from './semantic-search/types';
import { hasOperationalTranscript, type TranscriptWord } from '../transcript/types';

interface MediaSearchHitBase {
  assetId: string;
  sourceRevision: string;
  sourceStartMs: number;
  sourceEndMs: number;
  score: number;
}

export interface VisualMediaSearchHit extends MediaSearchHitBase {
  modality: 'visual';
  sampleTimeMs: number;
  sceneId?: string;
}

export interface SpokenMediaSearchHit extends MediaSearchHitBase {
  modality: 'spoken';
  text: string;
}

export type MediaSearchHit = VisualMediaSearchHit | SpokenMediaSearchHit;

export interface MediaSearchResult {
  query: string;
  ranking: 'grouped-by-modality';
  visual: VisualMediaSearchHit[];
  spoken: SpokenMediaSearchHit[];
  hits: MediaSearchHit[];
}

type SearchableAsset = MediaAsset & {
  transcriptStale?: boolean;
  transcriptSourceRevision?: string;
};

const normalizeText = (value: string): string => (
  value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '')
);
const clampScore = (score: number): number => (
  Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0
);

function visualScore(cosine: number): number {
  return clampScore((cosine + 1) / 2);
}

export function visualMediaSearchHits(
  matches: readonly SemanticMatch[],
  assets: readonly MediaAsset[],
): VisualMediaSearchHit[] {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const hits: VisualMediaSearchHit[] = [];
  for (const match of matches) {
    const asset = assetById.get(match.assetId);
    if (!asset) continue;
    const sourceRevision = sourceRevisionOf(asset);
    if (match.sourceRevision !== sourceRevision) continue;
    const sampleTimeMs = Math.max(0, Math.round(match.sampleTime * 1000));
    const sourceStartMs = match.sceneStart === undefined
      ? Math.max(0, sampleTimeMs - 500)
      : Math.max(0, Math.round(match.sceneStart * 1000));
    const sourceEndMs = match.sceneEnd === undefined
      ? sampleTimeMs + 500
      : Math.max(sourceStartMs + 1, Math.round(match.sceneEnd * 1000));
    hits.push({
      modality: 'visual',
      assetId: asset.id,
      sourceRevision,
      sourceStartMs,
      sourceEndMs,
      sampleTimeMs,
      sceneId: match.sceneId,
      score: visualScore(match.score),
    });
  }
  return hits.toSorted((left, right) => right.score - left.score
    || left.sourceStartMs - right.sourceStartMs
    || left.assetId.localeCompare(right.assetId));
}

function transcriptMatches(words: readonly TranscriptWord[], query: string, limit: number): Array<{
  start: number;
  end: number;
  text: string;
}> {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];
  const results: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start < words.length && results.length < limit; start += 1) {
    let normalized = '';
    for (let end = start; end < words.length; end += 1) {
      normalized += normalizeText(words[end]!.text);
      if (!normalizedQuery.startsWith(normalized)) break;
      if (normalized !== normalizedQuery) continue;
      results.push({
        start: Math.max(0, words[start]!.start),
        end: Math.max(words[start]!.start + 1, words[end]!.end),
        text: words.slice(start, end + 1).map((word) => word.text).join(''),
      });
      start = end;
      break;
    }
  }
  return results;
}

export function spokenMediaSearchHits(
  query: string,
  assets: readonly MediaAsset[],
  limit = 24,
): SpokenMediaSearchHit[] {
  const hits: SpokenMediaSearchHit[] = [];
  for (const asset of assets as readonly SearchableAsset[]) {
    if (!hasOperationalTranscript(asset)) continue;
    const sourceRevision = sourceRevisionOf(asset);
    if (asset.transcriptSourceRevision !== undefined
      && asset.transcriptSourceRevision !== sourceRevision) continue;
    for (const match of transcriptMatches(asset.transcript, query, Math.max(0, limit - hits.length))) {
      hits.push({
        modality: 'spoken',
        assetId: asset.id,
        sourceRevision,
        sourceStartMs: match.start,
        sourceEndMs: match.end,
        score: 1,
        text: match.text,
      });
    }
    if (hits.length >= limit) break;
  }
  return hits.toSorted((left, right) => right.score - left.score
    || left.sourceStartMs - right.sourceStartMs
    || left.assetId.localeCompare(right.assetId));
}

export function filterStaleMediaSearchHits(
  hits: readonly MediaSearchHit[],
  assets: readonly MediaAsset[],
): MediaSearchHit[] {
  const revisions = new Map(assets.map((asset) => [asset.id, sourceRevisionOf(asset)]));
  return hits.filter((hit) => revisions.get(hit.assetId) === hit.sourceRevision);
}

/** Visual and spoken scores stay normalized inside their modality; they are not falsely added together. */
export function buildMediaSearchResult(
  query: string,
  visual: readonly VisualMediaSearchHit[],
  spoken: readonly SpokenMediaSearchHit[],
  assets: readonly MediaAsset[],
): MediaSearchResult {
  const fresh = filterStaleMediaSearchHits([...visual, ...spoken], assets);
  const visualHits = fresh
    .filter((hit): hit is VisualMediaSearchHit => hit.modality === 'visual')
    .map((hit) => ({ ...hit, score: clampScore(hit.score) }))
    .toSorted((left, right) => right.score - left.score || left.sourceStartMs - right.sourceStartMs);
  const spokenHits = fresh
    .filter((hit): hit is SpokenMediaSearchHit => hit.modality === 'spoken')
    .map((hit) => ({ ...hit, score: clampScore(hit.score) }))
    .toSorted((left, right) => right.score - left.score || left.sourceStartMs - right.sourceStartMs);
  return {
    query,
    ranking: 'grouped-by-modality',
    visual: visualHits,
    spoken: spokenHits,
    hits: [...visualHits, ...spokenHits],
  };
}
