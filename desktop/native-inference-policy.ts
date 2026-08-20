import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import {
  CLAP_INFERENCE_CONTRACT,
  RHYTHM_INFERENCE_CONTRACT,
  SEMANTIC_INFERENCE_CONTRACT,
} from '../shared/vector-inference-contract.ts';
import type {
  DesktopAsrBackend,
  DesktopHardwareCapabilities,
  DesktopInferenceBackend,
  DesktopInferenceCapabilities,
} from '../shared/desktop-inference.ts';

export interface NativeInferenceRuntimeProbe {
  readonly platform: NodeJS.Platform;
  readonly transformerRuntime: boolean;
  readonly ffmpegRuntime: boolean;
  readonly rhythmRuntime?: boolean;
  readonly hardware?: DesktopHardwareCapabilities;
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
  hardware?: DesktopHardwareCapabilities,
): DesktopInferenceBackend | null {
  if (platform === 'win32') return gpuEnabled(hardware) ? 'directml' : 'native-cpu';
  if (platform === 'darwin') return 'coreml';
  if (platform === 'linux') return linuxCudaAvailable(hardware) ? 'cuda' : 'native-cpu';
  return null;
}

export function preferredNativeModelBackend(
  platform: NodeJS.Platform,
  hardware?: DesktopHardwareCapabilities,
): DesktopInferenceBackend | null {
  if (platform === 'win32') return gpuEnabled(hardware) ? 'directml' : 'native-cpu';
  if (platform === 'linux') return linuxCudaAvailable(hardware) ? 'cuda' : 'native-cpu';
  if (platform === 'darwin') return 'native-cpu';
  return null;
}

function gpuEnabled(hardware: DesktopHardwareCapabilities | undefined): boolean {
  return hardware === undefined || hardware.gpus.some((gpu) => gpu.vendor !== 'microsoft');
}

function linuxCudaAvailable(hardware: DesktopHardwareCapabilities | undefined): boolean {
  return hardware?.arch === 'x64'
    && hardware.gpus.some((gpu) => gpu.vendor === 'nvidia');
}

function browserGpuPreferred(
  platform: NodeJS.Platform,
  hardware: DesktopHardwareCapabilities | undefined,
  backend: DesktopInferenceBackend | null,
): boolean {
  return (platform === 'darwin' || platform === 'linux')
    && backend === 'native-cpu'
    && hardware?.hardwareAcceleration === true
    && hardware.gpus.length > 0;
}

export function resolveDesktopInferenceCapabilities(
  probe: NativeInferenceRuntimeProbe,
): DesktopInferenceCapabilities {
  const preferredBackend = preferredNativeInferenceBackend(probe.platform);
  const preferredModelBackend = preferredNativeModelBackend(probe.platform, probe.hardware);
  const preferredRhythmBackend = preferredNativeRhythmBackend(probe.platform, probe.hardware);
  const platform = probe.platform === 'darwin' || probe.platform === 'win32' || probe.platform === 'linux'
    ? probe.platform
    : 'unsupported';
  const modelMissing = [
    !preferredModelBackend ? 'unsupported platform' : '',
    !probe.transformerRuntime ? 'native ONNX runtime unavailable' : '',
    browserGpuPreferred(probe.platform, probe.hardware, preferredModelBackend)
      ? 'browser WebGPU preferred' : '',
  ].filter(Boolean);
  const asrMissing = [
    !preferredBackend ? 'unsupported platform' : '',
    !probe.ffmpegRuntime ? 'FFmpeg runtime unavailable' : '',
  ].filter(Boolean);
  const rhythmMissing = [
    !preferredRhythmBackend ? 'unsupported platform' : '',
    !(probe.rhythmRuntime ?? probe.transformerRuntime) ? 'native ONNX runtime unavailable' : '',
    browserGpuPreferred(probe.platform, probe.hardware, preferredRhythmBackend)
      ? 'browser WebGPU preferred' : '',
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
    ...(probe.hardware ? { hardware: probe.hardware } : {}),
    asr: capability(ASR_INFERENCE_CONTRACT.id, asrMissing),
    semantic: capability(SEMANTIC_INFERENCE_CONTRACT.id, modelMissing, preferredModelBackend),
    clap: capability(CLAP_INFERENCE_CONTRACT.id, modelMissing, preferredModelBackend),
    rhythm: capability(RHYTHM_INFERENCE_CONTRACT.id, rhythmMissing, preferredRhythmBackend),
  };
}
