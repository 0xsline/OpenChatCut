import { availableParallelism, totalmem } from 'node:os';

const MAX_RENDER_CONCURRENCY = 24;
const GIB = 1024 ** 3;

function cpuCount(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function configuredConcurrency(value, cores) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const percent = raw.match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) {
    const ratio = Math.min(100, Math.max(1, Number(percent[1]))) / 100;
    return Math.max(1, Math.min(cores, Math.floor(cores * ratio)));
  }
  if (/^\d+$/.test(raw)) return Math.max(1, Math.min(cores, Number(raw)));
  return null;
}

/**
 * Use most of the CPU during export while leaving one or two logical cores for
 * Electron and the OS. Remotion's default is 50% (capped at 8), which leaves a
 * lot of performance unused on modern Apple Silicon and Windows workstations.
 */
export function resolveRenderConcurrency({
  cores = availableParallelism(),
  memoryBytes = totalmem(),
  override = process.env.OPENCHATCUT_RENDER_CONCURRENCY,
} = {}) {
  const count = cpuCount(cores);
  const configured = configuredConcurrency(override, count);
  if (configured !== null) return configured;
  if (count <= 2) return 1;
  const cpuTarget = Math.round(count * 0.8);
  // Reserve half of physical RAM for Electron, the OS and other applications;
  // budget the remainder at ~1.25 GiB per headless render tab.
  const memoryTarget = Math.max(1, Math.floor((memoryBytes / GIB * 0.5) / 1.25));
  return Math.max(1, Math.min(MAX_RENDER_CONCURRENCY, cpuTarget, memoryTarget));
}

/** OffthreadVideo is memory-heavy; scale it more conservatively than pages. */
export function resolveOffthreadVideoThreads({ cores = availableParallelism() } = {}) {
  const count = cpuCount(cores);
  if (count <= 2) return 1;
  return Math.max(2, Math.min(4, Math.ceil(count / 4)));
}

/**
 * Remotion maps this to VideoToolbox on both Intel and Apple Silicon Macs, and
 * NVENC on Windows. We require it for the first attempt so a missing device is
 * surfaced to our explicit software retry. Alpha ProRes stays on software to
 * avoid platform-dependent alpha loss.
 */
export function remotionHardwareAcceleration(codec, {
  platform = process.platform,
  disabled = /^(?:1|true|yes)$/i.test(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? ''),
} = {}) {
  if (disabled || codec !== 'h264') return 'disable';
  return platform === 'darwin' || platform === 'win32' ? 'required' : 'disable';
}

/** Stable, high-quality H.264 bitrate scaled by output pixels and frame rate. */
export function resolveH264VideoBitrate({ width, height, fps, scale = 1 } = {}) {
  const outputWidth = Math.max(2, Number(width) * Number(scale));
  const outputHeight = Math.max(2, Number(height) * Number(scale));
  const frameRate = Math.max(1, Number(fps));
  const raw = Number.isFinite(outputWidth * outputHeight * frameRate)
    ? outputWidth * outputHeight * frameRate * 0.16
    : 10_000_000;
  const clamped = Math.max(4_000_000, Math.min(30_000_000, raw));
  return `${Math.ceil(clamped / 500_000) * 500}k`;
}

/** Runtime device/driver failure that an encoder-list probe cannot detect. */
export function isHardwareEncoderFailure(error) {
  const message = error instanceof Error
    ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
    : String(error ?? '');
  return /videotoolbox|nvenc|nvcuda|libcuda|no (?:nvenc )?capable devices|no device|device setup failed|hardware encoder|failed to open encoder|could not open encoder|error initializing output stream/i.test(message);
}

/** Execute one hardware attempt and retry only recognized encoder failures. */
export async function withHardwareEncoderFallback({
  render,
  hardwareOptions,
  softwareOptions,
  cleanup = async () => {},
  onFallback = () => {},
}) {
  try {
    return await render(hardwareOptions);
  } catch (error) {
    if (hardwareOptions.hardwareAcceleration === 'disable' || !isHardwareEncoderFailure(error)) throw error;
    await cleanup();
    onFallback(error);
    return render(softwareOptions);
  }
}
