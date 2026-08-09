export const CLAP_MODEL_ID = 'Xenova/clap-htsat-unfused';
export const CLAP_MODEL_REVISION = 'c28f2883575e590e04d3146ff0713c2448d691ba';
export const CLAP_SAMPLE_RATE = 48_000;
export const CLAP_EMBEDDING_DIMENSION = 512;

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
