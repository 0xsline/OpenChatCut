// Device capability probing + ASR backend/model selection.
// Each platform uses its own strengths (WebGPU on Metal/D3D12/Vulkan; model tier by
// memory) — the shipped build is identical everywhere, the choice is made at runtime.
// P0 note: thresholds are initial estimates; calibrate with real devices before release.
import type { AsrConfig, AsrDevice, AsrModelTier, DeviceProfile } from './local-asr-types';

export const WHISPER_MODELS: Record<AsrModelTier, string> = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
};

const DEFAULT_MEMORY_GB = 8;
const SMALL_TIER_MIN_GB = 6;
const WASM_SMALL_TIER_MIN_GB = 8;

function platformOf(): DeviceProfile['platform'] {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'win';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function deviceMemoryGB(): number {
  const raw = typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MEMORY_GB;
}

async function webgpuCapability(): Promise<{ available: boolean; vendor?: string; backend?: string }> {
  const gpu = typeof navigator !== 'undefined'
    ? (navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
    : undefined;
  if (!gpu?.requestAdapter) return { available: false };
  try {
    const adapter = await gpu.requestAdapter() as { info?: { vendor?: string; architecture?: string; description?: string; backend?: string } } | null;
    if (!adapter) return { available: false };
    return {
      available: true,
      vendor: typeof adapter.info?.vendor === 'string' ? adapter.info.vendor : undefined,
      backend: typeof adapter.info?.backend === 'string' ? adapter.info.backend : undefined,
    };
  } catch {
    return { available: false };
  }
}

export async function detectDeviceProfile(): Promise<DeviceProfile> {
  const [webgpu] = await Promise.all([webgpuCapability()]);
  return {
    platform: platformOf(),
    webgpu,
    deviceMemoryGB: deviceMemoryGB(),
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 4 : 4,
  };
}

/** Backend + model tier per device strengths: GPU first, tier by memory. */
export function chooseAsrConfig(profile: DeviceProfile): AsrConfig {
  const device: AsrDevice = profile.webgpu.available ? 'webgpu' : 'wasm';
  const gpuMin = device === 'webgpu' ? SMALL_TIER_MIN_GB : WASM_SMALL_TIER_MIN_GB;
  const tier: AsrModelTier = profile.deviceMemoryGB >= gpuMin ? 'small' : 'base';
  return { device, modelTier: tier, modelId: WHISPER_MODELS[tier] };
}
