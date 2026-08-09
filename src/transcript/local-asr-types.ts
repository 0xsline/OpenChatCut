// Shared types for the on-device ASR provider (whisper via transformers.js).
// Kept dependency-free so both the worker and the persist layer can import it.

/** Inference backend for on-device models. */
export type AsrDevice = 'webgpu' | 'wasm';

/** Whisper model tier (size class). */
export type AsrModelTier = 'tiny' | 'base' | 'small' | 'medium';

/** Device capabilities that drive backend + model-tier selection. */
export interface DeviceProfile {
  platform: 'mac' | 'win' | 'linux' | 'other';
  webgpu: { available: boolean; vendor?: string; backend?: string };
  deviceMemoryGB: number;
  hardwareConcurrency: number;
}

/** Resolved on-device ASR configuration for the current device. */
export interface AsrConfig {
  device: AsrDevice;
  modelTier: AsrModelTier;
  modelId: string;
  revision: string;
}

/** One word-level segment from the ASR worker (timestamps in seconds). */
export interface AsrChunk {
  text: string;
  start: number;
  end: number;
}

export interface AsrResult {
  text: string;
  chunks: AsrChunk[];
}

export type LocalAsrWorkerRequest =
  | { id: number; type: 'load'; device: AsrDevice; modelId: string; revision: string }
  | { id: number; type: 'transcribe'; samples: Float32Array; language: string };

export type LocalAsrWorkerResponse =
  | { id: number; type: 'result'; result: AsrResult }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'progress'; progress?: number; file?: string };
