export const SEMANTIC_MODEL_ID = 'Xenova/chinese-clip-vit-base-patch16';
export const SEMANTIC_MODEL_VERSION = 'chinese-clip-vit-base-patch16-q4-v1';
export const MAX_SEMANTIC_QUERY_LENGTH = 240;

export interface SemanticVectorRecord {
  scopeId: string;
  assetId: string;
  sampleTime: number;
  vector: number[];
}

export interface SemanticMatch {
  assetId: string;
  sampleTime: number;
  score: number;
}

export interface DuplicateMatch {
  leftAssetId: string;
  rightAssetId: string;
  score: number;
}

export interface FramePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  sampleTime: number;
}

export type SemanticDevice = 'webgpu' | 'wasm';

export type WorkerRequest =
  | { id: number; type: 'load'; device: SemanticDevice }
  | { id: number; type: 'embed-text'; text: string }
  | { id: number; type: 'embed-image'; frame: FramePixels };

export type WorkerResponse =
  | { id: number; type: 'result'; vector?: number[] }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'progress'; progress?: number; file?: string };
