import { SEMANTIC_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';

export const SEMANTIC_MODEL_ID = SEMANTIC_INFERENCE_CONTRACT.modelId;
export const SEMANTIC_MODEL_REVISION = SEMANTIC_INFERENCE_CONTRACT.revision;
export const SEMANTIC_MODEL_VERSION = 'chinese-clip-vit-base-patch16-q4-v1';
export const MAX_SEMANTIC_QUERY_LENGTH = 240;

export interface SemanticVectorRecord {
  scopeId: string;
  assetId: string;
  sampleTime: number;
  /** Source bytes revision captured when this embedding was produced. */
  sourceRevision?: string;
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
  vector: ArrayLike<number>;
}

export interface SemanticMatch {
  assetId: string;
  sampleTime: number;
  score: number;
  sourceRevision?: string;
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
}

export interface HybridTextHit {
  kind: 'chat' | 'caption' | 'transcript';
  projectId: string;
  ref: string;
  score: number;
}

export interface DuplicateMatch {
  leftAssetId: string;
  rightAssetId: string;
  score: number;
}

export interface PackedSemanticVectors {
  assetIds: string[];
  assetVectorOffsets: Uint32Array;
  vectorValueOffsets: Uint32Array;
  values: Float32Array;
}

export interface FramePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  sampleTime: number;
  sceneId?: string;
  sceneStart?: number;
  sceneEnd?: number;
}

export type SemanticDevice = 'webgpu' | 'wasm';

export type WorkerRequest =
  | { id: number; type: 'load'; device: SemanticDevice }
  | { id: number; type: 'embed-text'; text: string }
  | { id: number; type: 'embed-image'; frame: FramePixels }
  | {
    id: number;
    type: 'find-duplicates';
    threshold: number;
    vectors: PackedSemanticVectors;
  };

export type WorkerResult =
  | { type: 'loaded' }
  | { type: 'embedding'; vector: number[] }
  | { type: 'duplicates'; matches: DuplicateMatch[] };

export type WorkerResponse =
  | { id: number; type: 'result'; result: WorkerResult }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'progress'; progress?: number; file?: string };
