import type { MediaAsset } from '../../editor/types';
import { sampleAssetFrames, SemanticMediaDecodeError } from './mediaFrames';
import type { SemanticClient } from './semanticClient';
import type { SemanticDevice, SemanticVectorRecord } from './types';
import { replaceAssetVectors } from './vectorStore';

export interface IndexProgress {
  completed: number;
  skipped: number;
}

export const isAbortError = (reason: unknown) =>
  reason instanceof DOMException && reason.name === 'AbortError';

export async function loadWithFallback(
  client: SemanticClient,
  preferred: SemanticDevice,
  signal: AbortSignal,
  load: (device: SemanticDevice, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  try {
    await load(preferred, signal);
  } catch (reason) {
    if (preferred !== 'webgpu' || signal.aborted) throw reason;
    client.cancel();
    await load('wasm', signal);
  }
}

async function indexAsset(
  scopeId: string,
  client: SemanticClient,
  asset: MediaAsset,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const frames = await sampleAssetFrames(asset, signal);
    let records: SemanticVectorRecord[] = [];
    for (const frame of frames) {
      const vector = await client.embedImage(frame);
      records = [...records, { scopeId, assetId: asset.id, sampleTime: frame.sampleTime, vector }];
    }
    await replaceAssetVectors(scopeId, asset.id, records);
    return true;
  } catch (reason) {
    if (isAbortError(reason)) throw reason;
    if (reason instanceof SemanticMediaDecodeError) return false;
    throw reason;
  }
}

export async function indexSemanticAssets(
  scopeId: string,
  client: SemanticClient,
  assets: MediaAsset[],
  signal: AbortSignal,
  onProgress: (progress: IndexProgress) => void,
): Promise<IndexProgress> {
  let progress = { completed: 0, skipped: 0 };
  for (const asset of assets) {
    if (signal.aborted) throw new DOMException('Indexing canceled', 'AbortError');
    progress = await indexAsset(scopeId, client, asset, signal)
      ? { ...progress, completed: progress.completed + 1 }
      : { ...progress, skipped: progress.skipped + 1 };
    onProgress({ ...progress });
  }
  return progress;
}
