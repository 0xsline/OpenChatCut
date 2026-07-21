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

export function rankSemanticMatches(
  records: SemanticVectorRecord[],
  queryVector: number[],
  limit = SEMANTIC_RESULT_LIMIT,
): SemanticMatch[] {
  const normalizedQuery = normalizeVector(queryVector);
  return records
    .map((record) => ({
      assetId: record.assetId,
      sampleTime: record.sampleTime,
      score: dot(record.vector, normalizedQuery),
    }))
    .toSorted((left, right) => right.score - left.score)
    .slice(0, limit);
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
