import { ASR_INFERENCE_CONTRACT } from './asr-inference-contract.ts';
import {
  CLAP_INFERENCE_CONTRACT,
  RHYTHM_INFERENCE_CONTRACT,
  SEMANTIC_INFERENCE_CONTRACT,
} from './vector-inference-contract.ts';
import type {
  DesktopAsrChunk,
  DesktopAsrResponse,
  DesktopClapResponse,
  DesktopInferenceBackend,
  DesktopInferenceCapabilities,
  DesktopInferenceProgress,
  DesktopModelLoadResponse,
  DesktopRhythmResponse,
  DesktopSemanticResponse,
} from './desktop-inference.ts';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_ASR_RESPONSE_TEXT = 4 * 1024 * 1024;
const MAX_ASR_RESPONSE_CHUNKS = 200_000;
const MAX_ASR_CHUNK_TEXT = 4_096;
const MAX_ASR_OUTPUT_MS = ASR_INFERENCE_CONTRACT.maxAudioSeconds * 1_000;
const MAX_RHYTHM_OUTPUT_FRAMES = Math.floor(
  RHYTHM_INFERENCE_CONTRACT.sampleRate
    * RHYTHM_INFERENCE_CONTRACT.nativeMaxDurationSeconds
    / RHYTHM_INFERENCE_CONTRACT.hopLength,
) + 1;

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function isBackend(value: unknown): value is DesktopInferenceBackend {
  return value === 'coreml' || value === 'directml' || value === 'native-cpu' || value === 'native-metal';
}

function isModelCapability(value: unknown, contractId: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const capability = value as {
    available?: unknown;
    preferredBackend?: unknown;
    contractId?: unknown;
    reason?: unknown;
  };
  return typeof capability.available === 'boolean'
    && (capability.preferredBackend === null || isBackend(capability.preferredBackend))
    && capability.contractId === contractId
    && (capability.reason === undefined || typeof capability.reason === 'string');
}

export function isDesktopInferenceCapabilities(value: unknown): value is DesktopInferenceCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Partial<DesktopInferenceCapabilities>;
  return capabilities.version === 3
    && (capabilities.platform === 'darwin'
      || capabilities.platform === 'win32'
      || capabilities.platform === 'unsupported')
    && isModelCapability(capabilities.asr, ASR_INFERENCE_CONTRACT.id)
    && isModelCapability(capabilities.semantic, SEMANTIC_INFERENCE_CONTRACT.id)
    && isModelCapability(capabilities.clap, CLAP_INFERENCE_CONTRACT.id)
    && isModelCapability(capabilities.rhythm, RHYTHM_INFERENCE_CONTRACT.id);
}

function isDesktopAsrChunk(value: unknown): value is DesktopAsrChunk {
  if (typeof value !== 'object' || value === null) return false;
  const chunk = value as Partial<DesktopAsrChunk>;
  return typeof chunk.text === 'string' && chunk.text.length <= MAX_ASR_CHUNK_TEXT
    && typeof chunk.start === 'number' && Number.isFinite(chunk.start) && chunk.start >= 0
    && typeof chunk.end === 'number' && Number.isFinite(chunk.end)
    && chunk.end >= chunk.start && chunk.end <= MAX_ASR_OUTPUT_MS;
}

export function isDesktopAsrResponse(value: unknown): value is DesktopAsrResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<DesktopAsrResponse>;
  return isRequestId(response.requestId)
    && isBackend(response.backend) && typeof response.text === 'string'
    && response.text.length <= MAX_ASR_RESPONSE_TEXT
    && Array.isArray(response.chunks) && response.chunks.length <= MAX_ASR_RESPONSE_CHUNKS
    && response.chunks.every(isDesktopAsrChunk);
}

export function isDesktopModelLoadResponse(value: unknown): value is DesktopModelLoadResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<DesktopModelLoadResponse>;
  return isRequestId(response.requestId)
    && isBackend(response.backend)
    && response.result?.type === 'loaded';
}

function isFiniteVector(value: unknown, dimension: number): value is readonly number[] {
  return Array.isArray(value) && value.length === dimension
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function isDesktopSemanticResponse(value: unknown): value is DesktopSemanticResponse {
  if (isDesktopModelLoadResponse(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<DesktopSemanticResponse>;
  if (!isRequestId(response.requestId) || !isBackend(response.backend)
    || typeof response.result !== 'object' || response.result === null) return false;
  if (response.result.type === 'embedding') {
    return isFiniteVector(response.result.vector, SEMANTIC_INFERENCE_CONTRACT.embeddingDimension);
  }
  if (response.result.type !== 'duplicates' || !Array.isArray(response.result.matches)
    || response.result.matches.length > SEMANTIC_INFERENCE_CONTRACT.duplicateResultLimit) return false;
  return response.result.matches.every((match) => (
    typeof match.leftAssetId === 'string' && match.leftAssetId.length > 0 && match.leftAssetId.length <= 256
    && typeof match.rightAssetId === 'string' && match.rightAssetId.length > 0
    && match.rightAssetId.length <= 256 && match.rightAssetId !== match.leftAssetId
    && typeof match.score === 'number' && Number.isFinite(match.score)
    && match.score >= 0 && match.score <= 1
  ));
}

export function isDesktopClapResponse(value: unknown): value is DesktopClapResponse {
  if (isDesktopModelLoadResponse(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<DesktopClapResponse>;
  return isRequestId(response.requestId)
    && isBackend(response.backend)
    && response.result?.type === 'embedding'
    && isFiniteVector(response.result.vector, CLAP_INFERENCE_CONTRACT.embeddingDimension);
}

export function isDesktopRhythmResponse(value: unknown): value is DesktopRhythmResponse {
  if (isDesktopModelLoadResponse(value)) return true;
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Partial<DesktopRhythmResponse>;
  if (!isRequestId(response.requestId) || !isBackend(response.backend)
    || response.result?.type !== 'analysis') return false;
  const beat = response.result.beat;
  const downbeat = response.result.downbeat;
  return beat instanceof Float32Array
    && downbeat instanceof Float32Array
    && beat.length > 0
    && beat.length <= MAX_RHYTHM_OUTPUT_FRAMES
    && downbeat.length === beat.length
    && beat.every(Number.isFinite)
    && downbeat.every(Number.isFinite);
}

export function isDesktopInferenceProgress(value: unknown): value is DesktopInferenceProgress {
  if (typeof value !== 'object' || value === null) return false;
  const progress = value as Partial<DesktopInferenceProgress>;
  return isRequestId(progress.requestId)
    && (progress.progress === undefined
      || (typeof progress.progress === 'number' && Number.isFinite(progress.progress)))
    && (progress.file === undefined || typeof progress.file === 'string');
}
