import { spawn } from 'node:child_process';

export type H264Encoder =
  | 'h264_videotoolbox'
  | 'h264_nvenc'
  | 'h264_qsv'
  | 'h264_amf'
  | 'libx264';

const HARDWARE_ENCODERS = new Set<H264Encoder>([
  'h264_videotoolbox',
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
]);
const encoderCache = new Map<string, Promise<H264Encoder>>();

export function h264HardwareCandidates(platform: NodeJS.Platform = process.platform): H264Encoder[] {
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  return [];
}

export function isHardwareH264Encoder(encoder: H264Encoder): boolean {
  return HARDWARE_ENCODERS.has(encoder);
}

function disabledByEnvironment(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? '');
}

function probeEncoder(ffmpeg: string, encoder: H264Encoder): Promise<boolean> {
  return new Promise((resolve) => {
    const pixelFormat = encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p';
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1',
      '-frames:v', '1', '-an',
      '-c:v', encoder, '-pix_fmt', pixelFormat,
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Encoder-list checks are insufficient on Windows because FFmpeg may contain
 * NVENC while the PC has no NVIDIA GPU. Encode one 64x64 frame once per process
 * and cache the working encoder; all failures fall back to libx264.
 */
export function resolveH264Encoder(
  ffmpeg: string,
  platform: NodeJS.Platform = process.platform,
): Promise<H264Encoder> {
  const forced = process.env.OPENCHATCUT_H264_ENCODER?.trim() as H264Encoder | undefined;
  const key = `${ffmpeg}\0${platform}\0${forced ?? ''}\0${disabledByEnvironment()}`;
  const existing = encoderCache.get(key);
  if (existing) return existing;

  const resolving = (async (): Promise<H264Encoder> => {
    if (disabledByEnvironment()) return 'libx264';
    const known = new Set<H264Encoder>([...HARDWARE_ENCODERS, 'libx264']);
    const candidates = forced && known.has(forced)
      ? [forced]
      : h264HardwareCandidates(platform);
    for (const encoder of candidates) {
      if (encoder === 'libx264' || await probeEncoder(ffmpeg, encoder)) return encoder;
    }
    return 'libx264';
  })();
  encoderCache.set(key, resolving);
  return resolving;
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
}

/** High-quality average bitrate scaled by output pixels and frame rate. */
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
    ? Math.max(4_000_000, Math.min(30_000_000, raw))
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
}: H264EncodingOptions): string[] {
  const pixelFormat = encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p';
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
  args.push('-b:v', String(targetBitrate ?? 12_000_000));
  if (maxBitrate) args.push('-maxrate', String(maxBitrate));
  if (bufferSize) args.push('-bufsize', String(bufferSize));
  return args;
}
