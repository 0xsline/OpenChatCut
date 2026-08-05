import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

export type H264Encoder =
  | 'h264_videotoolbox'
  | 'h264_nvenc'
  | 'h264_qsv'
  | 'h264_amf'
  | 'h264_vaapi'
  | 'libx264';

export interface H264EncoderProfile {
  readonly id: H264Encoder;
  readonly label: string;
  readonly hardware: boolean;
  readonly transport: 'server';
}

export interface H264EncoderOutcome {
  readonly encoder: H264EncoderProfile;
  readonly encoderFallbackReason?: string;
}

type EncoderProbe = (encoder: H264Encoder) => Promise<boolean>;
interface PromiseConstructorWithResolvers {
  withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void };
}

// Node 22+ provides this API; the project TypeScript lib target has not exposed it yet.
const promiseConstructor = Promise as unknown as PromiseConstructorWithResolvers;

const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';
const PROBE_FRAME_SIZE = 64;
const PROBE_FRAME_BYTES = PROBE_FRAME_SIZE * PROBE_FRAME_SIZE * 3 / 2;
const VAAPI_DEVICE_PATTERN = /^\/dev\/dri\/renderD\d+$/;
const ENCODER_LABELS: Record<H264Encoder, string> = {
  h264_videotoolbox: 'Apple VideoToolbox',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel Quick Sync Video',
  h264_amf: 'AMD AMF',
  h264_vaapi: 'Linux VA-API',
  libx264: 'Software (libx264)',
};
const HARDWARE_ENCODERS: Record<Exclude<H264Encoder, 'libx264'>, true> = {
  h264_videotoolbox: true,
  h264_nvenc: true,
  h264_qsv: true,
  h264_amf: true,
  h264_vaapi: true,
};
const KNOWN_ENCODERS: Record<H264Encoder, true> = {
  ...HARDWARE_ENCODERS,
  libx264: true,
};
const encoderCache = new Map<string, Promise<H264Encoder>>();
const compiledEncoderCache = new Map<string, Promise<boolean>>();
const hwAccelsCache = new Map<string, Promise<Set<string>>>();

/** 平台感知的解码硬加速参数。编码器已知时用同 API（解码/编码同硬件上下文），
 * 否则按平台通用选择。内部 hwaccel 在流不支持时自动回退软件解码，无格式风险：
 * 解码帧输出系统内存（nv12），与现有 CPU filter 链完全兼容。 */
export function hwDecodeArgs(encoder?: H264Encoder): string[] {
  if (encoder === 'h264_videotoolbox') return ['-hwaccel', 'videotoolbox'];
  if (encoder === 'h264_nvenc') return ['-hwaccel', 'cuda'];
  if (encoder === 'h264_qsv') return ['-hwaccel', 'qsv'];
  if (encoder === 'h264_amf') return ['-hwaccel', 'd3d11va'];
  if (encoder === 'h264_vaapi') return ['-hwaccel', 'vaapi'];
  switch (process.platform) {
    case 'darwin': return ['-hwaccel', 'videotoolbox'];
    case 'win32': return ['-hwaccel', 'd3d11va'];
    case 'linux': return ['-hwaccel', 'vaapi'];
    default: return [];
  }
}

async function availableHwAccels(ffmpeg: string): Promise<Set<string>> {
  const key = ffmpeg;
  const cached = hwAccelsCache.get(key);
  if (cached) return cached;
  const { promise, resolve } = promiseConstructor.withResolvers<Set<string>>();
  const child = spawn(ffmpeg, ['-hide_banner', '-hwaccels'], {
    cwd: dirname(ffmpeg),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk}`.slice(0, 8192); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.once('error', () => { clearTimeout(timer); resolve(new Set()); });
  child.once('close', () => {
    clearTimeout(timer);
    resolve(new Set(output.split(/\s+/).filter(Boolean)));
  });
  hwAccelsCache.set(key, promise);
  return promise;
}

const qualityModeCache = new Map<string, Promise<boolean>>();

/** Whether the ffmpeg build's hardware encoder accepts constant-quality mode
 * (-q:v / -global_quality / rc_mode CQP / -qp). Cached per encoder. */
export async function probeEncoderQualityMode(ffmpeg: string, encoder: H264Encoder): Promise<boolean> {
  if (encoder === 'libx264') return false;
  const key = `${ffmpeg}\0${encoder}`;
  const cached = qualityModeCache.get(key);
  if (cached) return cached;
  const { promise, resolve } = promiseConstructor.withResolvers<boolean>();
  const child = spawn(ffmpeg, ['-hide_banner', '-h', `encoder=${encoder}`], {
    cwd: dirname(ffmpeg),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer) => { output = `${output}${chunk}`.slice(0, 16_384); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.once('error', () => { clearTimeout(timer); resolve(false); });
  child.once('close', () => {
    clearTimeout(timer);
    const supported = /\b(?:q:v|global_quality|rc_mode|qp_i| -qp |qp)\b/i.test(output);
    resolve(supported);
  });
  qualityModeCache.set(key, promise);
  return promise;
}

/** 探测 ffmpeg 编译支持后返回解码硬加速参数；不支持时为空数组（软解）。 */
export async function resolveHwDecodeArgs(ffmpeg: string, encoder?: H264Encoder): Promise<string[]> {
  const candidate = hwDecodeArgs(encoder);
  if (!candidate.length) return [];
  const available = await availableHwAccels(ffmpeg);
  return available.has(candidate[1]!) ? candidate : [];
}

export function h264HardwareCandidates(platform: NodeJS.Platform = process.platform): H264Encoder[] {
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  if (platform === 'linux') return ['h264_nvenc', 'h264_qsv', 'h264_vaapi'];
  return [];
}

export function isHardwareH264Encoder(encoder: H264Encoder): boolean {
  return encoder !== 'libx264' && HARDWARE_ENCODERS[encoder] === true;
}
export function shouldFallbackH264Encoder(encoder: H264Encoder, error: unknown): boolean {
  if (!isHardwareH264Encoder(encoder)) return false;
  const message = error instanceof Error
    ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
    : String(error ?? '');
  return /videotoolbox|nvenc|nvcuda|libcuda|qsv|quick sync|mfx|amf|vaapi|va-api|renderD\d+|no (?:nvenc )?capable devices|no device|device setup failed|hardware encoder|failed to open encoder|could not open encoder|error initializing output stream/i.test(message);
}


export function h264EncoderFallbackReason(encoder: H264Encoder, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  let failureClass = 'runtime-failure';
  if (/no (?:nvenc )?capable devices|no device|device unavailable|renderD\d+|cannot load|not available/i.test(message)) {
    failureClass = 'device-unavailable';
  } else if (/unsupported|unknown encoder|encoder not found|not implemented/i.test(message)) {
    failureClass = 'unsupported';
  } else if (/initializ|failed to open|could not open|device setup/i.test(message)) {
    failureClass = 'initialization-failed';
  }
  return `${encoder}: ${failureClass}`;
}

export function resolveVaapiDevice(
  value = process.env.OPENCHATCUT_VAAPI_DEVICE,
): string {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return VAAPI_DEVICE_PATTERN.test(candidate) ? candidate : DEFAULT_VAAPI_DEVICE;
}

export function h264EncoderProfile(encoder: H264Encoder): H264EncoderProfile {
  return {
    id: encoder,
    label: ENCODER_LABELS[encoder],
    hardware: isHardwareH264Encoder(encoder),
    transport: 'server',
  };
}

export function h264GlobalArgs(
  encoder: H264Encoder,
  vaapiDevice = resolveVaapiDevice(),
): string[] {
  return encoder === 'h264_vaapi' ? ['-vaapi_device', vaapiDevice] : [];
}

export function h264FilterChain(encoder: H264Encoder, filters: readonly string[]): string {
  const chain = filters.filter((filter) => filter.length > 0);
  return encoder === 'h264_vaapi'
    ? [...chain, 'format=nv12', 'hwupload'].join(',')
    : chain.join(',');
}

export function h264ProbeArgs(
  encoder: H264Encoder,
  vaapiDevice = resolveVaapiDevice(),
): string[] {
  const pixelFormat = encoder === 'h264_vaapi'
    ? 'vaapi'
    : encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p';
  const filter = h264FilterChain(encoder, []);
  return [
    '-hide_banner', '-loglevel', 'error',
    ...h264GlobalArgs(encoder, vaapiDevice),
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-video_size', `${PROBE_FRAME_SIZE}x${PROBE_FRAME_SIZE}`, '-framerate', '1', '-i', 'pipe:0',
    ...(filter ? ['-vf', filter] : []),
    '-frames:v', '1', '-an',
    '-c:v', encoder, '-pix_fmt', pixelFormat,
    '-f', 'null', '-',
  ];
}

function disabledByEnvironment(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? '');
}

function probeEncoder(
  ffmpeg: string,
  encoder: H264Encoder,
  vaapiDevice: string,
): Promise<boolean> {
  const { promise, resolve } = promiseConstructor.withResolvers<boolean>();
  const child = spawn(ffmpeg, h264ProbeArgs(encoder, vaapiDevice), {
    cwd: dirname(ffmpeg),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
  child.once('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve(code === 0);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(Buffer.alloc(PROBE_FRAME_BYTES));
  return promise;
}
function probeCompiledEncoder(ffmpeg: string, encoder: H264Encoder): Promise<boolean> {
  const key = `${ffmpeg}\0${encoder}`;
  const cached = compiledEncoderCache.get(key);
  if (cached) return cached;
  const { promise, resolve } = promiseConstructor.withResolvers<boolean>();
  const child = spawn(ffmpeg, ['-hide_banner', '-h', `encoder=${encoder}`], {
    cwd: dirname(ffmpeg),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (chunk: Buffer) => { output = `${output}${chunk}`.slice(0, 16_384); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.once('error', () => { clearTimeout(timer); resolve(false); });
  child.once('close', (code) => {
    clearTimeout(timer);
    resolve(code === 0 && output.includes(`Encoder ${encoder} `));
  });
  compiledEncoderCache.set(key, promise);
  return promise;
}

export async function selectWorkingH264Encoder(
  candidates: readonly H264Encoder[],
  probe: EncoderProbe,
): Promise<H264Encoder> {
  for (const encoder of candidates) {
    if (encoder === 'libx264' || await probe(encoder)) return encoder;
  }
  return 'libx264';
}

/**
 * Encoder-list checks cannot prove that a GPU and driver are usable. Encode one
 * 64x64 frame once per process and cache the first working encoder.
 */
export function resolveH264Encoder(
  ffmpeg: string,
  platform: NodeJS.Platform = process.platform,
): Promise<H264Encoder> {
  const forcedValue = process.env.OPENCHATCUT_H264_ENCODER?.trim();
  const forced = forcedValue && Object.hasOwn(KNOWN_ENCODERS, forcedValue)
    ? forcedValue as H264Encoder
    : undefined;
  const disabled = disabledByEnvironment();
  const vaapiDevice = resolveVaapiDevice();
  const key = `${ffmpeg}\0${platform}\0${forcedValue ?? ''}\0${disabled}\0${vaapiDevice}`;
  const existing = encoderCache.get(key);
  if (existing) return existing;

  const candidates = disabled
    ? ['libx264'] as const
    : forced ? [forced] : h264HardwareCandidates(platform);
  const resolving = selectWorkingH264Encoder(
    candidates,
    (encoder) => probeEncoder(ffmpeg, encoder, vaapiDevice),
  );
  encoderCache.set(key, resolving);
  return resolving;
}

export async function resolveH264EncoderProfile(
  ffmpeg: string,
  platform: NodeJS.Platform = process.platform,
): Promise<H264EncoderProfile> {
  return h264EncoderProfile(await resolveH264Encoder(ffmpeg, platform));
}

export interface H264RenderOptions {
  readonly h264Profile: H264EncoderProfile;
  readonly vaapiDevice: string;
}

export async function resolveH264RenderOptions(
  probeFfmpeg: string,
  rendererFfmpeg = probeFfmpeg,
  platform: NodeJS.Platform = process.platform,
): Promise<H264RenderOptions> {
  const detected = await resolveH264EncoderProfile(probeFfmpeg, platform);
  const rendererSupportsDetected = !detected.hardware
    || await probeCompiledEncoder(rendererFfmpeg, detected.id);
  return {
    h264Profile: rendererSupportsDetected ? detected : h264EncoderProfile('libx264'),
    vaapiDevice: resolveVaapiDevice(),
  };
}

export function h264EncoderAttempts(preferred: H264Encoder): H264Encoder[] {
  return preferred === 'libx264' ? ['libx264'] : [preferred, 'libx264'];
}

export interface H264EncodingOptions {
  encoder: H264Encoder;
  /** Average target bitrate. Hardware encoders require a bitrate target. */
  targetBitrate?: number;
  /** Optional VBV ceiling. Import normalization uses this to preserve its cap. */
  maxBitrate?: number;
  bufferSize?: number;
  softwareCrf?: number;
  softwarePreset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow';
  /** Hardware constant-quality value (CQP / -q:v). When set and supported by
   * the encoder build, replaces bitrate mode for proxy transcodes: same
   * perceptual quality at lower bitrate and less rate-control CPU. */
  hardwareQuality?: number;
}

/** High-quality average bitrate scaled by output pixels and frame rate (4K headroom up to 60 Mbps). */
export function resolveH264TargetBitrate({
  width,
  height,
  fps,
}: {
  width: number;
  height: number;
  fps: number;
}): number {
  const raw = Number(width) * Number(height) * Number(fps) * 0.16;
  const clamped = Number.isFinite(raw)
    ? Math.max(4_000_000, Math.min(60_000_000, raw))
    : 10_000_000;
  return Math.ceil(clamped / 500_000) * 500_000;
}

/** Build conservative arguments shared by import normalization and FPS retiming. */
export function h264EncodingArgs({
  encoder,
  targetBitrate,
  maxBitrate,
  bufferSize,
  softwareCrf = 18,
  softwarePreset = 'medium',
  hardwareQuality,
}: H264EncodingOptions): string[] {
  const pixelFormat = encoder === 'h264_vaapi'
    ? 'vaapi'
    : encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p';
  const args = ['-c:v', encoder, '-pix_fmt', pixelFormat];
  if (encoder === 'libx264') {
    args.push('-preset', softwarePreset);
    if (!targetBitrate) return [...args, '-crf', String(softwareCrf)];
    const ceiling = maxBitrate ?? targetBitrate;
    return [...args,
      '-b:v', String(targetBitrate),
      '-maxrate', String(ceiling),
      '-bufsize', String(bufferSize ?? ceiling * 2),
    ];
  }
  if (hardwareQuality !== undefined) {
    const q = String(hardwareQuality);
    if (encoder === 'h264_nvenc') return [...args, '-rc_mode', 'CQP', '-global_quality', q];
    if (encoder === 'h264_qsv') return [...args, '-global_quality', q];
    if (encoder === 'h264_videotoolbox') return [...args, '-q:v', q];
    if (encoder === 'h264_amf') return [...args, '-rc', 'cqp', '-qp_i', q, '-qp_p', q];
    if (encoder === 'h264_vaapi') return [...args, '-qp', q];
    // fall through to bitrate mode for unknown hardware encoders
  }
  args.push('-b:v', String(targetBitrate ?? 12_000_000));
  if (maxBitrate) args.push('-maxrate', String(maxBitrate));
  if (bufferSize) args.push('-bufsize', String(bufferSize));
  return args;
}
