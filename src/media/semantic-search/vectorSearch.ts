import type {
  DuplicateMatch, PackedSemanticVectors, SemanticMatch, SemanticVectorRecord,
} from './types';

export const SEMANTIC_RESULT_LIMIT = 24;
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.985;
const MAX_PACKED_OFFSET = 0xffff_ffff;

export const dot = (left: ArrayLike<number>, right: ArrayLike<number>) => {
  let sum = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) sum += Number(left[index] ?? 0) * Number(right[index] ?? 0);
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
  records: readonly SemanticVectorRecord[],
  queryVector: ArrayLike<number>,
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
  const ranked = Array.from(best.values()).toSorted((left, right) => right.score - left.score);
  // If it's obviously not as good as the best hit, don't sneak in to replenish the number. The highest score ≤0 indicates that the whole is irrelevant, and there is no lower limit at this time.
  // It is up to the caller to judge by looking at the scores, so as not to return any.
  const top = ranked[0]?.score ?? 0;
  const floor = top > 0 ? top * SEMANTIC_RELATIVE_FLOOR : -Infinity;
  return ranked.filter((match) => match.score >= floor).slice(0, limit);
}

export function findDuplicateAssets(
  records: readonly SemanticVectorRecord[],
  threshold = DUPLICATE_SIMILARITY_THRESHOLD,
): DuplicateMatch[] {
  const vectorsByAsset = groupVectorsByAsset(records);
  const assets = Array.from(vectorsByAsset.entries());
  const matches: DuplicateMatch[] = [];
  for (let left = 0; left < assets.length; left += 1) {
    for (let right = left + 1; right < assets.length; right += 1) {
      const score = coverageSimilarity(assets[left]![1], assets[right]![1]);
      if (score >= threshold) {
        matches.push({ leftAssetId: assets[left]![0], rightAssetId: assets[right]![0], score });
      }
    }
  }
  return matches.toSorted((left, right) => right.score - left.score);
}

export function packSemanticVectors(records: readonly SemanticVectorRecord[]): PackedSemanticVectors {
  const vectorsByAsset = groupVectorsByAsset(records);
  let vectorCount = 0;
  let valueCount = 0;
  for (const vectors of vectorsByAsset.values()) {
    vectorCount = addPackedLength(vectorCount, vectors.length);
    for (const vector of vectors) valueCount = addPackedLength(valueCount, vector.length);
  }
  const assetIds = Array.from(vectorsByAsset.keys());
  const assetVectorOffsets = new Uint32Array(assetIds.length + 1);
  const vectorValueOffsets = new Uint32Array(vectorCount + 1);
  const values = new Float32Array(valueCount);
  writePackedVectors(vectorsByAsset, assetVectorOffsets, vectorValueOffsets, values);
  return { assetIds, assetVectorOffsets, vectorValueOffsets, values };
}

export function findDuplicateAssetsPacked(
  packed: PackedSemanticVectors,
  threshold = DUPLICATE_SIMILARITY_THRESHOLD,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  for (let left = 0; left < packed.assetIds.length; left += 1) {
    for (let right = left + 1; right < packed.assetIds.length; right += 1) {
      const score = packedCoverageSimilarity(packed, left, right);
      if (score >= threshold) {
        matches.push({ leftAssetId: packed.assetIds[left]!, rightAssetId: packed.assetIds[right]!, score });
      }
    }
  }
  return matches.toSorted((left, right) => right.score - left.score);
}

function groupVectorsByAsset(records: readonly SemanticVectorRecord[]): Map<string, ArrayLike<number>[]> {
  const vectorsByAsset = new Map<string, ArrayLike<number>[]>();
  for (const record of records) {
    const vectors = vectorsByAsset.get(record.assetId);
    if (vectors) vectors.push(record.vector);
    else vectorsByAsset.set(record.assetId, [record.vector]);
  }
  return vectorsByAsset;
}

function addPackedLength(total: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid semantic vector length');
  const next = total + amount;
  if (!Number.isSafeInteger(next) || next > MAX_PACKED_OFFSET) throw new Error('Semantic vector snapshot is too large');
  return next;
}

function writePackedVectors(
  vectorsByAsset: Map<string, ArrayLike<number>[]>,
  assetOffsets: Uint32Array,
  vectorOffsets: Uint32Array,
  values: Float32Array,
): void {
  let assetIndex = 0;
  let vectorIndex = 0;
  let valueIndex = 0;
  for (const vectors of vectorsByAsset.values()) {
    assetOffsets[assetIndex] = vectorIndex;
    for (const vector of vectors) {
      vectorOffsets[vectorIndex] = valueIndex;
      values.set(vector, valueIndex);
      valueIndex += vector.length;
      vectorIndex += 1;
    }
    assetIndex += 1;
  }
  assetOffsets[assetIndex] = vectorIndex;
  vectorOffsets[vectorIndex] = valueIndex;
}

function averageBestSimilarity(
  source: ArrayLike<ArrayLike<number>>,
  candidates: ArrayLike<ArrayLike<number>>,
): number {
  let total = 0;
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    let best = -1;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      best = Math.max(best, dot(source[sourceIndex]!, candidates[candidateIndex]!));
    }
    total += best;
  }
  return source.length > 0 ? total / source.length : -1;
}

function coverageSimilarity(
  left: ArrayLike<ArrayLike<number>>,
  right: ArrayLike<ArrayLike<number>>,
): number {
  return (averageBestSimilarity(left, right) + averageBestSimilarity(right, left)) / 2;
}

function packedCoverageSimilarity(packed: PackedSemanticVectors, leftAsset: number, rightAsset: number): number {
  const leftStart = packed.assetVectorOffsets[leftAsset]!;
  const leftEnd = packed.assetVectorOffsets[leftAsset + 1]!;
  const rightStart = packed.assetVectorOffsets[rightAsset]!;
  const rightEnd = packed.assetVectorOffsets[rightAsset + 1]!;
  return (averageBestPacked(packed, leftStart, leftEnd, rightStart, rightEnd)
    + averageBestPacked(packed, rightStart, rightEnd, leftStart, leftEnd)) / 2;
}

function averageBestPacked(
  packed: PackedSemanticVectors,
  sourceStart: number,
  sourceEnd: number,
  candidateStart: number,
  candidateEnd: number,
): number {
  let total = 0;
  for (let source = sourceStart; source < sourceEnd; source += 1) {
    let best = -1;
    for (let candidate = candidateStart; candidate < candidateEnd; candidate += 1) {
      best = Math.max(best, dotPacked(packed, source, candidate));
    }
    total += best;
  }
  return sourceEnd > sourceStart ? total / (sourceEnd - sourceStart) : -1;
}

function dotPacked(packed: PackedSemanticVectors, leftVector: number, rightVector: number): number {
  const leftStart = packed.vectorValueOffsets[leftVector]!;
  const rightStart = packed.vectorValueOffsets[rightVector]!;
  const leftLength = packed.vectorValueOffsets[leftVector + 1]! - leftStart;
  const rightLength = packed.vectorValueOffsets[rightVector + 1]! - rightStart;
  const length = Math.min(leftLength, rightLength);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += packed.values[leftStart + index]! * packed.values[rightStart + index]!;
  }
  return sum;
}
