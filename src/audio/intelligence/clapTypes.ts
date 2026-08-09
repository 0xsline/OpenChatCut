import { CLAP_INFERENCE_CONTRACT } from '../../../shared/vector-inference-contract';

export const CLAP_MODEL_ID = CLAP_INFERENCE_CONTRACT.modelId;
export const CLAP_MODEL_REVISION = CLAP_INFERENCE_CONTRACT.revision;
export const CLAP_SAMPLE_RATE = CLAP_INFERENCE_CONTRACT.sampleRate;
export const CLAP_EMBEDDING_DIMENSION = CLAP_INFERENCE_CONTRACT.embeddingDimension;

export type ClapBackend = 'webgpu' | 'wasm';

export type ClapWorkerRequest =
  | { id: number; type: 'load'; backend: ClapBackend }
  | { id: number; type: 'embed'; samples: Float32Array; sampleRate: number };

export type ClapWorkerResult =
  | { type: 'loaded' }
  | { type: 'embedding'; vector: number[] };

export type ClapWorkerResponse =
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'result'; result: ClapWorkerResult }
  | { id: number; type: 'error'; message: string };
