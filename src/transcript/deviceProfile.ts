// Device capability probing + ASR backend/model selection.
// Each platform uses its own strengths (WebGPU on Metal/D3D12/Vulkan; model tier by
// memory) — the shipped build is identical everywhere, the choice is made at runtime.
// P0 note: thresholds are initial estimates; calibrate with real devices before release.
import { asrModelEntry } from '../../shared/asr-models';
import type { AsrConfig, AsrDevice, AsrModelTier, DeviceProfile } from './local-asr-types';

const DEFAULT_MEMORY_GB = 8;

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

/**
 * Backend + model tier. User's explicit setting (settings → 本地模型 → 默认模型,
 *  synced to localStorage 'cc.asrModel') wins; otherwise base. Measured:
 *  wasm small runs at RTF ~0.9 (a 10-min clip takes ~9 min) while base is
 *  ~2.5x faster with comparable quality for typical speech, so the auto
 *  default stays on base and small/medium are explicit choices.
 *  NOTE: onnxruntime-web's webgpu EP produces hallucinated output for these
 *  quantized whisper models on both software renderers and real Metal (verified
 *  M5/Chrome); wasm is the reliable default. */
export function chooseAsrConfig(profile: DeviceProfile): AsrConfig {
  let preferred: string = '';
  try {
    preferred = globalThis.localStorage?.getItem('cc.asrModel') ?? '';
  } catch {
    preferred = '';
  }
  const tier: AsrModelTier = preferred === 'tiny' || preferred === 'base'
    || preferred === 'small' || preferred === 'medium'
    ? preferred
    : 'base';
  const model = asrModelEntry(tier);
  if (!model) throw new Error(`Unsupported local ASR model tier: ${tier}`);
  // WebGPU is an explicit opt-in (settings → 本地模型 → WebGPU 加速) and only
  // applies to tiers with fp16/fp32 catalog files (medium has none registered:
  // its fp32 encoder alone is 1.2GB). Once a WebGPU run produced an empty
  // transcript we remember it and stay on wasm from then on.
  const device: AsrDevice = asrBackendPreference() === 'webgpu'
    && !asrWebgpuBroken()
    && profile.webgpu.available
    && tier !== 'medium'
    ? 'webgpu'
    : 'wasm';
  return { device, modelTier: tier, modelId: model.modelId, revision: model.revision };
}

const ASR_BACKEND_KEY = 'cc.asrBackend';
const ASR_WEBGPU_BROKEN_KEY = 'cc.asrWebgpuBroken';

/** Explicit backend opt-in ('webgpu' or ''). Empty = current default (wasm). */
export function asrBackendPreference(): string {
  try {
    return globalThis.localStorage?.getItem(ASR_BACKEND_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Remember that the WebGPU path produced an empty transcript; stay on wasm. */
export function markAsrWebgpuBroken(): void {
  try {
    globalThis.localStorage?.setItem(ASR_WEBGPU_BROKEN_KEY, '1');
  } catch {
    // Persisting is best-effort; the current run already fell back to wasm.
  }
}

function asrWebgpuBroken(): boolean {
  try {
    return globalThis.localStorage?.getItem(ASR_WEBGPU_BROKEN_KEY) === '1';
  } catch {
    return false;
  }
}
