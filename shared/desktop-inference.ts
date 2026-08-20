import { ASR_INFERENCE_CONTRACT } from './asr-inference-contract.ts';
import {
  CLAP_INFERENCE_CONTRACT,
  RHYTHM_INFERENCE_CONTRACT,
  SEMANTIC_INFERENCE_CONTRACT,
} from './vector-inference-contract.ts';

export const DESKTOP_INFERENCE_CHANNELS = {
  capabilities: 'openchatcut:inference-capabilities',
  setEnabled: 'openchatcut:inference-set-enabled',
  preloadAsr: 'openchatcut:inference-preload-asr',
  transcribe: 'openchatcut:inference-transcribe',
  semantic: 'openchatcut:inference-semantic',
  clap: 'openchatcut:inference-clap',
  rhythm: 'openchatcut:inference-rhythm',
  cancel: 'openchatcut:inference-cancel',
  progress: 'openchatcut:inference-progress',
} as const;

export type DesktopInferenceBackend = 'coreml' | 'cuda' | 'directml' | 'native-cpu' | 'native-metal';
export type DesktopAsrBackend = 'directml' | 'native-cpu' | 'native-metal';

export type DesktopGpuVendor = 'amd' | 'apple' | 'intel' | 'microsoft' | 'nvidia' | 'unknown';

export interface DesktopGpuDevice {
  readonly active: boolean;
  readonly vendor: DesktopGpuVendor;
  readonly vendorId?: number;
  readonly deviceId?: number;
  readonly description?: string;
}

export interface DesktopHardwareCapabilities {
  readonly platform: 'darwin' | 'win32' | 'linux' | 'unsupported';
  readonly arch: string;
  readonly cpu: {
    readonly model: string;
    readonly logicalCores: number;
    readonly totalMemoryBytes: number;
  };
  readonly hardwareAcceleration: boolean;
  readonly gpus: readonly DesktopGpuDevice[];
  readonly graphicsFeatures: Readonly<Record<string, string>>;
  readonly driverVendor?: string;
  readonly driverVersion?: string;
}

interface DesktopModelCapability<ContractId extends string> {
  readonly available: boolean;
  readonly preferredBackend: DesktopInferenceBackend | null;
  readonly contractId: ContractId;
  readonly reason?: string;
}

export interface DesktopInferenceCapabilities {
  readonly version: 3;
  readonly platform: 'darwin' | 'win32' | 'linux' | 'unsupported';
  readonly hardware?: DesktopHardwareCapabilities;
  readonly asr: DesktopModelCapability<typeof ASR_INFERENCE_CONTRACT.id>;
  readonly semantic: DesktopModelCapability<typeof SEMANTIC_INFERENCE_CONTRACT.id>;
  readonly clap: DesktopModelCapability<typeof CLAP_INFERENCE_CONTRACT.id>;
  readonly rhythm: DesktopModelCapability<typeof RHYTHM_INFERENCE_CONTRACT.id>;
}

export interface DesktopAsrRequest {
  readonly requestId: string;
  readonly contractId: typeof ASR_INFERENCE_CONTRACT.id;
  readonly sourcePath: string;
  readonly modelId: string;
  readonly revision: string;
  readonly language: string;
}
export interface DesktopAsrPreloadRequest {
  readonly requestId: string;
  readonly contractId: typeof ASR_INFERENCE_CONTRACT.id;
  readonly action: 'load';
  readonly modelId: string;
  readonly revision: string;
}


export interface DesktopAsrChunk {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface DesktopAsrResponse {
  readonly requestId: string;
  readonly backend: DesktopAsrBackend;
  readonly text: string;
  readonly chunks: readonly DesktopAsrChunk[];
}
export interface DesktopModelLoadResponse {
  readonly requestId: string;
  readonly backend: DesktopInferenceBackend;
  readonly result: { readonly type: 'loaded' };
}

export interface DesktopSemanticFrame {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface DesktopPackedSemanticVectors {
  readonly assetIds: readonly string[];
  readonly assetVectorOffsets: Uint32Array;
  readonly vectorValueOffsets: Uint32Array;
  readonly values: Float32Array;
}

export type DesktopSemanticRequest =
  | {
      readonly requestId: string;
      readonly contractId: typeof SEMANTIC_INFERENCE_CONTRACT.id;
      readonly action: 'load';
    }
  | {
      readonly requestId: string;
      readonly contractId: typeof SEMANTIC_INFERENCE_CONTRACT.id;
      readonly action: 'embed-text';
      readonly text: string;
    }
  | {
      readonly requestId: string;
      readonly contractId: typeof SEMANTIC_INFERENCE_CONTRACT.id;
      readonly action: 'embed-image';
      readonly frame: DesktopSemanticFrame;
    }
  | {
      readonly requestId: string;
      readonly contractId: typeof SEMANTIC_INFERENCE_CONTRACT.id;
      readonly action: 'find-duplicates';
      readonly threshold: number;
      readonly vectors: DesktopPackedSemanticVectors;
    };

export interface DesktopSemanticDuplicateMatch {
  readonly leftAssetId: string;
  readonly rightAssetId: string;
  readonly score: number;
}

export type DesktopSemanticResponse =
  | DesktopModelLoadResponse
  | {
      readonly requestId: string;
      readonly backend: DesktopInferenceBackend;
      readonly result: { readonly type: 'embedding'; readonly vector: readonly number[] };
    }
  | {
      readonly requestId: string;
      readonly backend: DesktopInferenceBackend;
      readonly result: {
        readonly type: 'duplicates';
        readonly matches: readonly DesktopSemanticDuplicateMatch[];
      };
    };

export type DesktopClapRequest =
  | {
      readonly requestId: string;
      readonly contractId: typeof CLAP_INFERENCE_CONTRACT.id;
      readonly action: 'load';
    }
  | {
      readonly requestId: string;
      readonly contractId: typeof CLAP_INFERENCE_CONTRACT.id;
      readonly action: 'embed';
      readonly samples: Float32Array;
      readonly sampleRate: typeof CLAP_INFERENCE_CONTRACT.sampleRate;
    };

export type DesktopClapResponse =
  | DesktopModelLoadResponse
  | {
      readonly requestId: string;
      readonly backend: DesktopInferenceBackend;
      readonly result: { readonly type: 'embedding'; readonly vector: readonly number[] };
    };

export type DesktopRhythmRequest =
  | {
      readonly requestId: string;
      readonly contractId: typeof RHYTHM_INFERENCE_CONTRACT.id;
      readonly action: 'load';
    }
  | {
      readonly requestId: string;
      readonly contractId: typeof RHYTHM_INFERENCE_CONTRACT.id;
      readonly action: 'analyze';
      readonly samples: Float32Array;
      readonly sampleRate: typeof RHYTHM_INFERENCE_CONTRACT.sampleRate;
    };

export type DesktopRhythmResponse =
  | DesktopModelLoadResponse
  | {
      readonly requestId: string;
      readonly backend: DesktopInferenceBackend;
      readonly result: {
        readonly type: 'analysis';
        readonly beat: Float32Array;
        readonly downbeat: Float32Array;
      };
    };


export interface DesktopInferenceProgress {
  readonly requestId: string;
  readonly progress?: number;
  readonly file?: string;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REVISION = /^[a-f0-9]{40}$/;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/;
const MAX_SOURCE_PATH = 2_048;
const MAX_SEMANTIC_QUERY_LENGTH = 240;
const MAX_SEMANTIC_PIXELS = 448 * 448;
const MAX_SEMANTIC_ASSETS = 2_000;
const MAX_SEMANTIC_VECTOR_VALUES = 2_000_000;
const MAX_CLAP_SAMPLES =
  CLAP_INFERENCE_CONTRACT.sampleRate * CLAP_INFERENCE_CONTRACT.windowSeconds;
const MAX_RHYTHM_SAMPLES =
  RHYTHM_INFERENCE_CONTRACT.sampleRate * RHYTHM_INFERENCE_CONTRACT.nativeMaxDurationSeconds;
export function isDesktopInferenceRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}


function validSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SOURCE_PATH
    || !value.startsWith('/media/uploads/') || value.includes('\\')) return false;
  try {
    const parsed = new URL(value, 'http://openchatcut.local');
    return parsed.origin === 'http://openchatcut.local'
      && parsed.search === ''
      && parsed.hash === ''
      && /^\/media\/uploads\/[^/]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function parseDesktopAsrRequest(value: unknown): DesktopAsrRequest {
  if (typeof value !== 'object' || value === null
    || !hasExactKeys(value, ['requestId', 'contractId', 'sourcePath', 'modelId', 'revision', 'language'])) {
    throw new Error('invalid desktop ASR request');
  }
  const request = value as Partial<DesktopAsrRequest>;
  if (!isDesktopInferenceRequestId(request.requestId)
    || request.contractId !== ASR_INFERENCE_CONTRACT.id
    || !validSourcePath(request.sourcePath)
    || typeof request.modelId !== 'string' || !MODEL_ID.test(request.modelId)
    || typeof request.revision !== 'string' || !REVISION.test(request.revision)
    || typeof request.language !== 'string' || !LANGUAGE.test(request.language)) {
    throw new Error('invalid desktop ASR request');
  }
  return {
    requestId: request.requestId,
    contractId: request.contractId,
    sourcePath: request.sourcePath,
    modelId: request.modelId,
    revision: request.revision,
    language: request.language,
  };
}
export function parseDesktopAsrPreloadRequest(value: unknown): DesktopAsrPreloadRequest {
  if (typeof value !== 'object' || value === null
    || !hasExactKeys(value, ['requestId', 'contractId', 'action', 'modelId', 'revision'])) {
    throw new Error('invalid desktop ASR preload request');
  }
  const request = value as Partial<DesktopAsrPreloadRequest>;
  if (!isDesktopInferenceRequestId(request.requestId)
    || request.action !== 'load'
    || request.contractId !== ASR_INFERENCE_CONTRACT.id
    || typeof request.modelId !== 'string' || !MODEL_ID.test(request.modelId)
    || typeof request.revision !== 'string' || !REVISION.test(request.revision)) {
    throw new Error('invalid desktop ASR preload request');
  }
  return {
    requestId: request.requestId,
    contractId: request.contractId,
    action: 'load',
    modelId: request.modelId,
    revision: request.revision,
  };
}

function validSemanticFrame(value: unknown): value is DesktopSemanticFrame {
  if (typeof value !== 'object' || value === null) return false;
  const frame = value as Partial<DesktopSemanticFrame>;
  if (!(frame.data instanceof Uint8ClampedArray)
    || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)) return false;
  const pixels = (frame.width as number) * (frame.height as number);
  return pixels > 0 && pixels <= MAX_SEMANTIC_PIXELS && frame.data.length === pixels * 4;
}

function offsetsAreValid(offsets: Uint32Array, expectedEnd: number): boolean {
  if (offsets.length === 0 || offsets[0] !== 0) return false;
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index]! < offsets[index - 1]!) return false;
  }
  return offsets[offsets.length - 1] === expectedEnd;
}

function validPackedSemanticVectors(value: unknown): value is DesktopPackedSemanticVectors {
  if (typeof value !== 'object' || value === null
    || !hasExactKeys(value, ['assetIds', 'assetVectorOffsets', 'vectorValueOffsets', 'values'])) return false;
  const vectors = value as Partial<DesktopPackedSemanticVectors>;
  if (!Array.isArray(vectors.assetIds) || vectors.assetIds.length > MAX_SEMANTIC_ASSETS
    || !vectors.assetIds.every((assetId) => typeof assetId === 'string'
      && assetId.length > 0 && assetId.length <= 256)
    || new Set(vectors.assetIds).size !== vectors.assetIds.length
    || !(vectors.assetVectorOffsets instanceof Uint32Array)
    || !(vectors.vectorValueOffsets instanceof Uint32Array)
    || !(vectors.values instanceof Float32Array)
    || vectors.values.length > MAX_SEMANTIC_VECTOR_VALUES
    || vectors.assetVectorOffsets.length !== vectors.assetIds.length + 1) return false;
  const vectorCount = vectors.vectorValueOffsets.length - 1;
  if (vectorCount < 0
    || !offsetsAreValid(vectors.assetVectorOffsets, vectorCount)
    || !offsetsAreValid(vectors.vectorValueOffsets, vectors.values.length)) return false;
  for (let index = 1; index < vectors.assetVectorOffsets.length; index += 1) {
    const count = vectors.assetVectorOffsets[index]! - vectors.assetVectorOffsets[index - 1]!;
    if (count <= 0 || count > SEMANTIC_INFERENCE_CONTRACT.maxVectorsPerAsset) return false;
  }
  for (let index = 1; index < vectors.vectorValueOffsets.length; index += 1) {
    if (vectors.vectorValueOffsets[index]! - vectors.vectorValueOffsets[index - 1]!
      !== SEMANTIC_INFERENCE_CONTRACT.embeddingDimension) return false;
  }
  return vectors.values.every(Number.isFinite);
}

export function parseDesktopSemanticRequest(value: unknown): DesktopSemanticRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid desktop semantic request');
  const request = value as Partial<DesktopSemanticRequest>;
  const common = isDesktopInferenceRequestId(request.requestId)
    && request.contractId === SEMANTIC_INFERENCE_CONTRACT.id;
  if (common && request.action === 'load'
    && hasExactKeys(value, ['requestId', 'contractId', 'action'])) {
    return { requestId: request.requestId!, contractId: request.contractId, action: 'load' };
  }
  if (common && request.action === 'embed-text'
    && hasExactKeys(value, ['requestId', 'contractId', 'action', 'text'])
    && typeof request.text === 'string' && request.text.length > 0
    && request.text.length <= MAX_SEMANTIC_QUERY_LENGTH) {
    return { requestId: request.requestId!, contractId: request.contractId, action: 'embed-text', text: request.text };
  }
  if (common && request.action === 'embed-image'
    && hasExactKeys(value, ['requestId', 'contractId', 'action', 'frame'])
    && validSemanticFrame(request.frame)) {
    return { requestId: request.requestId!, contractId: request.contractId, action: 'embed-image', frame: request.frame };
  }
  if (common && request.action === 'find-duplicates'
    && hasExactKeys(value, ['requestId', 'contractId', 'action', 'threshold', 'vectors'])
    && typeof request.threshold === 'number' && Number.isFinite(request.threshold)
    && request.threshold >= 0 && request.threshold <= 1
    && validPackedSemanticVectors(request.vectors)) {
    return {
      requestId: request.requestId!, contractId: request.contractId, action: 'find-duplicates',
      threshold: request.threshold, vectors: request.vectors,
    };
  }
  throw new Error('invalid desktop semantic request');
}

export function parseDesktopClapRequest(value: unknown): DesktopClapRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid desktop CLAP request');
  const request = value as Partial<DesktopClapRequest>;
  const common = isDesktopInferenceRequestId(request.requestId)
    && request.contractId === CLAP_INFERENCE_CONTRACT.id;
  if (common && request.action === 'load'
    && hasExactKeys(value, ['requestId', 'contractId', 'action'])) {
    return { requestId: request.requestId!, contractId: request.contractId, action: 'load' };
  }
  if (common && request.action === 'embed'
    && hasExactKeys(value, ['requestId', 'contractId', 'action', 'samples', 'sampleRate'])
    && request.samples instanceof Float32Array
    && request.samples.length > 0 && request.samples.length <= MAX_CLAP_SAMPLES
    && request.sampleRate === CLAP_INFERENCE_CONTRACT.sampleRate
    && request.samples.every(Number.isFinite)) {
    return {
      requestId: request.requestId!, contractId: request.contractId, action: 'embed',
      samples: request.samples, sampleRate: request.sampleRate,
    };
  }
  throw new Error('invalid desktop CLAP request');
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function parseDesktopRhythmRequest(value: unknown): DesktopRhythmRequest {
  if (typeof value !== 'object' || value === null) throw new Error('invalid desktop rhythm request');
  const request = value as Partial<DesktopRhythmRequest>;
  const common = isDesktopInferenceRequestId(request.requestId)
    && request.contractId === RHYTHM_INFERENCE_CONTRACT.id;
  if (common && request.action === 'load'
    && hasExactKeys(value, ['requestId', 'contractId', 'action'])) {
    return { requestId: request.requestId!, contractId: request.contractId, action: 'load' };
  }
  if (!common || request.action !== 'analyze'
    || !hasExactKeys(value, ['requestId', 'contractId', 'action', 'samples', 'sampleRate'])
    || !(request.samples instanceof Float32Array)
    || request.samples.length < RHYTHM_INFERENCE_CONTRACT.minimumSamples
    || request.samples.length > MAX_RHYTHM_SAMPLES
    || request.sampleRate !== RHYTHM_INFERENCE_CONTRACT.sampleRate
    || !request.samples.every(Number.isFinite)) {
    throw new Error('invalid desktop rhythm request');
  }
  return {
    requestId: request.requestId!, contractId: request.contractId, action: 'analyze',
    samples: request.samples, sampleRate: request.sampleRate,
  };
}
export {
  isDesktopAsrResponse,
  isDesktopClapResponse,
  isDesktopInferenceCapabilities,
  isDesktopInferenceProgress,
  isDesktopModelLoadResponse,
  isDesktopRhythmResponse,
  isDesktopSemanticResponse,
} from './desktop-inference-response.ts';
