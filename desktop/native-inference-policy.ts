import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import {
  CLAP_INFERENCE_CONTRACT,
  RHYTHM_INFERENCE_CONTRACT,
  SEMANTIC_INFERENCE_CONTRACT,
} from '../shared/vector-inference-contract.ts';
import type {
  DesktopAsrBackend,
  DesktopInferenceBackend,
  DesktopInferenceCapabilities,
} from '../shared/desktop-inference.ts';

export interface NativeInferenceRuntimeProbe {
  readonly platform: NodeJS.Platform;
  readonly transformerRuntime: boolean;
  readonly ffmpegRuntime: boolean;
  readonly rhythmRuntime?: boolean;
}

export function preferredNativeInferenceBackend(platform: NodeJS.Platform): DesktopAsrBackend | null {
  // Desktop ASR runs whisper.cpp: Metal on macOS, CPU elsewhere (whisper.cpp
  // has no DirectML backend; NVIDIA users can opt into the cuBLAS build).
  if (platform === 'darwin') return 'native-metal';
  if (platform === 'win32' || platform === 'linux') return 'native-cpu';
  return null;
}

export function preferredNativeRhythmBackend(
  platform: NodeJS.Platform,
): DesktopInferenceBackend | null {
  if (platform === 'win32') return 'directml';
  if (platform === 'darwin') return 'coreml';
  return null;
}

export function resolveDesktopInferenceCapabilities(
  probe: NativeInferenceRuntimeProbe,
): DesktopInferenceCapabilities {
  const preferredBackend = preferredNativeInferenceBackend(probe.platform);
  const preferredRhythmBackend = preferredNativeRhythmBackend(probe.platform);
  const platform = probe.platform === 'darwin' || probe.platform === 'win32' || probe.platform === 'linux'
    ? probe.platform
    : 'unsupported';
  const modelMissing = [
    !preferredBackend ? 'unsupported platform' : '',
    !probe.transformerRuntime ? 'native ONNX runtime unavailable' : '',
  ].filter(Boolean);
  const asrMissing = [
    !preferredBackend ? 'unsupported platform' : '',
    !probe.ffmpegRuntime ? 'FFmpeg runtime unavailable' : '',
  ].filter(Boolean);
  const rhythmMissing = [
    !preferredRhythmBackend ? 'unsupported platform' : '',
    !(probe.rhythmRuntime ?? probe.transformerRuntime) ? 'native ONNX runtime unavailable' : '',
  ].filter(Boolean);
  const capability = <ContractId extends string>(
    contractId: ContractId,
    missing: readonly string[],
    backend: DesktopInferenceBackend | null = preferredBackend,
  ) => ({
    available: missing.length === 0,
    preferredBackend: backend,
    contractId,
    ...(missing.length ? { reason: missing.join('; ') } : {}),
  });
  return {
    version: 3,
    platform,
    asr: capability(ASR_INFERENCE_CONTRACT.id, asrMissing),
    semantic: capability(SEMANTIC_INFERENCE_CONTRACT.id, modelMissing),
    clap: capability(CLAP_INFERENCE_CONTRACT.id, modelMissing),
    rhythm: capability(RHYTHM_INFERENCE_CONTRACT.id, rhythmMissing, preferredRhythmBackend),
  };
}
