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
 * Remotion natively maps H.264 to VideoToolbox on macOS and NVENC on Windows
 * and Linux. Other probed engines are selected through a narrow FFmpeg override.
 */
export function remotionHardwareAcceleration(codec, {
  platform = process.platform,
  disabled = /^(?:1|true|yes)$/i.test(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? ''),
  encoder,
} = {}) {
  if (disabled || codec !== 'h264' || encoder === 'libx264') return 'disable';
  if (encoder === 'h264_videotoolbox') return platform === 'darwin' ? 'required' : 'disable';
  if (encoder === 'h264_nvenc') {
    return platform === 'win32' || platform === 'linux' ? 'required' : 'disable';
  }
  if (encoder) return 'disable';
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? 'required'
    : 'disable';
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
  return /videotoolbox|nvenc|nvcuda|libcuda|qsv|quick sync|mfx|amf|vaapi|va-api|renderD\d+|no (?:nvenc )?capable devices|no device|device setup failed|hardware encoder|failed to open encoder|could not open encoder|error initializing output stream/i.test(message);
}

export function hardwareEncoderFailureClass(error) {
  const message = error instanceof Error
    ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
    : String(error ?? '');
  if (/no (?:nvenc )?capable devices|no device|device unavailable|renderD\d+|cannot load|not available/i.test(message)) {
    return 'device-unavailable';
  }
  if (/unsupported|unknown encoder|encoder not found|not implemented/i.test(message)) {
    return 'unsupported';
  }
  if (/initializ|failed to open|could not open|device setup/i.test(message)) {
    return 'initialization-failed';
  }
  return 'runtime-failure';
}

const SOFTWARE_H264_PROFILE = Object.freeze({
  id: 'libx264',
  label: 'Software (libx264)',
  hardware: false,
  transport: 'server',
});
const DIRECT_H264_ENCODERS = {
  h264_videotoolbox: true,
  h264_nvenc: true,
  h264_qsv: true,
  h264_amf: true,
  h264_vaapi: true,
};
const VAAPI_DEVICE_PATTERN = /^\/dev\/dri\/renderD\d+$/;

function overrideH264Args(args, encoder, vaapiDevice) {
  const next = [...args];
  const codecIndex = next.findIndex((arg, index) => arg === '-c:v' && index + 1 < next.length);
  if (codecIndex < 0 || next[codecIndex + 1] === 'copy') return next;
  next[codecIndex + 1] = encoder;
  const pixelFormat = encoder === 'h264_vaapi'
    ? 'vaapi'
    : encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p';
  const pixelIndex = next.indexOf('-pix_fmt');
  if (pixelIndex >= 0 && pixelIndex + 1 < next.length) next[pixelIndex + 1] = pixelFormat;
  else next.splice(codecIndex, 0, '-pix_fmt', pixelFormat);
  if (encoder !== 'h264_vaapi') return next;

  const deviceIndex = next.indexOf('-i');
  next.splice(Math.max(0, deviceIndex), 0, '-vaapi_device', vaapiDevice);
  const filterIndex = next.indexOf('-vf');
  if (filterIndex >= 0 && filterIndex + 1 < next.length) {
    next[filterIndex + 1] = `${next[filterIndex + 1]},format=nv12,hwupload`;
  } else {
    const outputCodecIndex = next.indexOf('-c:v');
    next.splice(outputCodecIndex, 0, '-vf', 'format=nv12,hwupload');
  }
  return next;
}

/** Override only H.264 encoding steps; final copy/mux steps stay untouched. */
export function h264FfmpegOverride(encoder, {
  vaapiDevice = process.env.OPENCHATCUT_VAAPI_DEVICE,
} = {}) {
  if (!Object.hasOwn(DIRECT_H264_ENCODERS, encoder)) {
    throw new Error(`unsupported direct H.264 encoder: ${String(encoder)}`);
  }
  const rawDevice = String(vaapiDevice ?? '').trim();
  const device = VAAPI_DEVICE_PATTERN.test(rawDevice) ? rawDevice : '/dev/dri/renderD128';
  return ({ args }) => overrideH264Args(args, encoder, device);
}

/** A declared hardware attempt always reports the profile that actually completed. */
export async function withEncoderProfileFallback({
  render,
  hardwareOptions,
  softwareOptions,
  hardwareProfile,
  softwareProfile = SOFTWARE_H264_PROFILE,
  cleanup = async () => {},
  onFallback = () => {},
}) {
  try {
    return { result: await render(hardwareOptions), encoder: hardwareProfile };
  } catch (error) {
    if (!hardwareProfile.hardware || !isHardwareEncoderFailure(error)) throw error;
    const encoderFallbackReason = `${hardwareProfile.id}: ${hardwareEncoderFailureClass(error)}`;
    await cleanup();
    onFallback(error);
    const result = await render(softwareOptions);
    return { result, encoder: softwareProfile, encoderFallbackReason };
  }
}

/** Backward-compatible fallback helper for Remotion's native hardware mode. */
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
