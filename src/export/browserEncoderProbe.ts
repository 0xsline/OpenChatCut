import type { BrowserVideoCodec } from './browserExport';
import { avcHighProfileCodecString, h264LevelIdc, mediabunnyAvcLevelIdc } from './h264Level';
import { H264_HARDWARE_MAX_DIMENSION } from './mediaSettings';

export type BrowserHardwareAcceleration = 'prefer-hardware' | 'prefer-software';

/** Answers VideoEncoder.isConfigSupported(); injectable so Node verifies can stand in for WebCodecs. */
export type VideoEncoderSupportProbe = (config: VideoEncoderConfig) => Promise<{ supported?: boolean }>;

export interface BrowserEncoderRequest {
  codec: BrowserVideoCodec;
  /** encoded frame size: the web renderer's canvas after scaling */
  width: number;
  height: number;
  /** what the export passes to renderMediaOnWeb: bit/s, or its 'high' preset */
  videoBitrate: number | 'high';
  hardwareAcceleration: BrowserHardwareAcceleration;
}

export interface BrowserEncoderProbeResult {
  supported: boolean;
  config: VideoEncoderConfig;
  /** One line for issues/diagnostics; never shown as the user-facing reason. */
  detail: string;
}

/**
 * The GPU behind WebCodecs shares the hardware H.264 encoder's 4096 px
 * per-dimension cap (see remotion/performance.mjs); asking it for a larger
 * frame fails after the frames are rendered. Software is slower but finishes.
 */
export function browserHardwareAcceleration(width: number, height: number): BrowserHardwareAcceleration {
  return width > H264_HARDWARE_MAX_DIMENSION || height > H264_HARDWARE_MAX_DIMENSION
    ? 'prefer-software'
    : 'prefer-hardware';
}

// Mediabunny's Quality#_toVideoBitrate, which renderMediaOnWeb applies to the
// 'high' preset (QUALITY_HIGH, factor 2). Keep the operation order: the
// parity verify compares the rounded result bit for bit.
const REFERENCE_PIXELS = 1920 * 1080;
const REFERENCE_BITRATE = 3_000_000;
const QUALITY_HIGH_FACTOR = 2;
const CODEC_EFFICIENCY: Record<BrowserVideoCodec, number> = { h264: 1.0, vp8: 1.2 };

/** The bitrate the web renderer's encoder is configured with. */
export function browserEncoderBitrate(
  codec: BrowserVideoCodec,
  width: number,
  height: number,
  videoBitrate: number | 'high',
): number {
  if (typeof videoBitrate === 'number') return videoBitrate;
  const scaleFactor = Math.pow((width * height) / REFERENCE_PIXELS, 0.95);
  const baseBitrate = REFERENCE_BITRATE * scaleFactor;
  const codecAdjustedBitrate = baseBitrate * CODEC_EFFICIENCY[codec];
  const finalBitrate = codecAdjustedBitrate * QUALITY_HIGH_FACTOR;
  return Math.ceil(finalBitrate / 1000) * 1000;
}

/**
 * The VideoEncoderConfig that @remotion/web-renderer 4.0.509 makes Mediabunny
 * 1.50.8 check with VideoEncoder.isConfigSupported() before its first frame;
 * a rejection there is the "This specific encoder configuration (...) is not
 * supported by this browser" failure. It carries no frame rate: the renderer
 * never gives Mediabunny one, so probing with a frame rate would ask the
 * browser a stricter question than the export does.
 */
export function browserVideoEncoderConfig(request: BrowserEncoderRequest): VideoEncoderConfig {
  const { codec, width, height, hardwareAcceleration } = request;
  const bitrate = browserEncoderBitrate(codec, width, height, request.videoBitrate);
  return {
    codec: codec === 'h264'
      ? avcHighProfileCodecString(mediabunnyAvcLevelIdc(width, height, bitrate))
      : 'vp8',
    width,
    height,
    displayWidth: width,
    displayHeight: height,
    bitrate,
    alpha: 'discard',
    latencyMode: 'quality',
    hardwareAcceleration,
    ...(codec === 'h264' ? { avc: { format: 'avc' as const } } : {}),
  };
}

function nativeVideoEncoderProbe(): VideoEncoderSupportProbe | null {
  const encoder = globalThis.VideoEncoder;
  return encoder ? (config) => encoder.isConfigSupported(config) : null;
}

function describe(config: VideoEncoderConfig, verdict: string): string {
  return `VideoEncoder ${config.codec} ${config.width}x${config.height} ${config.bitrate} bps `
    + `${config.hardwareAcceleration}: ${verdict}`;
}

/** Ask the browser the exact question the render will ask, before any frame is drawn. */
export async function probeBrowserEncoder(
  request: BrowserEncoderRequest,
  probe: VideoEncoderSupportProbe | null = nativeVideoEncoderProbe(),
): Promise<BrowserEncoderProbeResult> {
  const config = browserVideoEncoderConfig(request);
  if (!probe) return { supported: false, config, detail: describe(config, 'WebCodecs VideoEncoder unavailable') };
  try {
    const support = await probe(config);
    const supported = support.supported === true;
    return { supported, config, detail: describe(config, supported ? 'supported' : 'not supported') };
  } catch (error) {
    // isConfigSupported rejects malformed configs with a TypeError; the
    // render's own check would throw the same way.
    return { supported: false, config, detail: describe(config, error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * MIME type for the MediaCapabilities power-efficiency probe. Unlike the
 * encoder config above, this describes the stream the export produces, so its
 * AVC level accounts for the frame rate: 1080p60 is Level 4.2, not 4.0.
 */
export function browserEncodingContentType(
  codec: BrowserVideoCodec,
  shape: { width: number; height: number; fps: number; bitrate: number },
): string {
  return codec === 'h264'
    ? `video/mp4; codecs="${avcHighProfileCodecString(h264LevelIdc(shape))}"`
    : 'video/webm; codecs="vp8"';
}
