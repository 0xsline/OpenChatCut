import type { DuplicateMatch, SemanticMatch, SemanticVectorRecord } from './types';

export const SEMANTIC_RESULT_LIMIT = 24;
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.985;

const dot = (left: number[], right: number[]) => {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0);
  return sum;
};

export function normalizeVector(vector: ArrayLike<number>): number[] {
  let magnitude = 0;
  for (let index = 0; index < vector.length; index += 1) magnitude += Number(vector[index] ?? 0) ** 2;
  const scale = Math.sqrt(magnitude) || 1;
  return Array.from(vector, (value) => Number(value) / scale);
}

/** Relative lower limit: Results lower than the maximum score are discarded. */
export const SEMANTIC_RELATIVE_FLOOR = 0.85;

export function rankSemanticMatches(
  records: SemanticVectorRecord[],
  queryVector: number[],
  limit = SEMANTIC_RESULT_LIMIT,
): SemanticMatch[] {
  const normalizedQuery = normalizeVector(queryVector);
  // Only the frame with the highest score is retained for each asset: a video will index more than a dozen sampling points. If it does not converge, it will be the same shot.
  // The entire result list can be filled up, and the really relevant asset behind will not be squeezed in.
  const best = new Map<string, SemanticMatch>();
  for (const record of records) {
    const score = dot(record.vector, normalizedQuery);
    const prev = best.get(record.assetId);
    if (!prev || score > prev.score) {
      best.set(record.assetId, { assetId: record.assetId, sampleTime: record.sampleTime, score });
    }
  }
  const ranked = [...best.values()].toSorted((left, right) => right.score - left.score);
  // If it's obviously not as good as the best hit, don't sneak in to replenish the number. The highest score ≤0 indicates that the whole is irrelevant, and there is no lower limit at this time.
  // It is up to the caller to judge by looking at the scores, so as not to return any.
  const top = ranked[0]?.score ?? 0;
  const floor = top > 0 ? top * SEMANTIC_RELATIVE_FLOOR : -Infinity;
  return ranked.filter((match) => match.score >= floor).slice(0, limit);
}

export function findDuplicateAssets(
  records: SemanticVectorRecord[],
  threshold = DUPLICATE_SIMILARITY_THRESHOLD,
): DuplicateMatch[] {
  const vectorsByAsset = new Map<string, number[][]>();
  for (const record of records) {
    const vectors = vectorsByAsset.get(record.assetId) ?? [];
    vectorsByAsset.set(record.assetId, [...vectors, record.vector]);
  }
  const assets = [...vectorsByAsset.entries()];
  let matches: DuplicateMatch[] = [];
  for (let left = 0; left < assets.length; left += 1) {
    for (let right = left + 1; right < assets.length; right += 1) {
      const score = coverageSimilarity(assets[left]![1], assets[right]![1]);
      if (score >= threshold) {
        matches = [...matches, { leftAssetId: assets[left]![0], rightAssetId: assets[right]![0], score }];
      }
    }
  }
  return matches.toSorted((left, right) => right.score - left.score);
}

function averageBestSimilarity(source: number[][], candidates: number[][]): number {
  const total = source.reduce((sum, vector) => {
    const best = candidates.reduce((score, candidate) => Math.max(score, dot(vector, candidate)), -1);
    return sum + best;
  }, 0);
  return source.length > 0 ? total / source.length : -1;
}

function coverageSimilarity(left: number[][], right: number[][]): number {
  return (averageBestSimilarity(left, right) + averageBestSimilarity(right, left)) / 2;
}
