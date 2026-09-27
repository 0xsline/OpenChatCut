/**
 * H.264 levels (ITU-T H.264 Annex A, Table A-1), reduced to the limits that
 * decide whether a stream's frame size, macroblock rate and bitrate fit.
 * `maxBr` is in 1000 bit/s: the Baseline/Main VCL factor, which is also the
 * cap Mediabunny applies. High profile may go 1.25x higher (Table A-2), so a
 * level picked against this cap is never too low for the stream.
 */
interface H264Level {
  /** level_idc: level x 10, the last byte of an `avc1.PPCCLL` codec string */
  readonly idc: number;
  /** MaxMBPS: macroblocks per second */
  readonly maxMbps: number;
  /** MaxFS: macroblocks per frame */
  readonly maxFs: number;
  /** MaxBR in 1000 bit/s */
  readonly maxBr: number;
}

// Level 1b is omitted: High profile signals it with a separate idc and no
// export here is small enough to need it.
const H264_LEVELS: readonly H264Level[] = [
  { idc: 10, maxMbps: 1_485, maxFs: 99, maxBr: 64 },
  { idc: 11, maxMbps: 3_000, maxFs: 396, maxBr: 192 },
  { idc: 12, maxMbps: 6_000, maxFs: 396, maxBr: 384 },
  { idc: 13, maxMbps: 11_880, maxFs: 396, maxBr: 768 },
  { idc: 20, maxMbps: 11_880, maxFs: 396, maxBr: 2_000 },
  { idc: 21, maxMbps: 19_800, maxFs: 792, maxBr: 4_000 },
  { idc: 22, maxMbps: 20_250, maxFs: 1_620, maxBr: 4_000 },
  { idc: 30, maxMbps: 40_500, maxFs: 1_620, maxBr: 10_000 },
  { idc: 31, maxMbps: 108_000, maxFs: 3_600, maxBr: 14_000 },
  { idc: 32, maxMbps: 216_000, maxFs: 5_120, maxBr: 20_000 },
  { idc: 40, maxMbps: 245_760, maxFs: 8_192, maxBr: 20_000 },
  { idc: 41, maxMbps: 245_760, maxFs: 8_192, maxBr: 50_000 },
  { idc: 42, maxMbps: 522_240, maxFs: 8_704, maxBr: 50_000 },
  { idc: 50, maxMbps: 589_824, maxFs: 22_080, maxBr: 135_000 },
  { idc: 51, maxMbps: 983_040, maxFs: 36_864, maxBr: 240_000 },
  { idc: 52, maxMbps: 2_073_600, maxFs: 36_864, maxBr: 240_000 },
  { idc: 60, maxMbps: 4_177_920, maxFs: 139_264, maxBr: 240_000 },
  { idc: 61, maxMbps: 8_355_840, maxFs: 139_264, maxBr: 480_000 },
  { idc: 62, maxMbps: 16_711_680, maxFs: 139_264, maxBr: 800_000 },
];
const HIGHEST_LEVEL = H264_LEVELS[H264_LEVELS.length - 1]!;

export interface H264StreamShape {
  width: number;
  height: number;
  /** frames per second; fractional rates such as 60000/1001 are fine */
  fps: number;
  /** target bitrate in bit/s */
  bitrate: number;
}

function macroblocks(pixels: number): number {
  return Math.ceil(pixels / 16);
}

function fitsLevel(level: H264Level, { width, height, fps, bitrate }: H264StreamShape): boolean {
  const widthInMbs = macroblocks(width);
  const heightInMbs = macroblocks(height);
  const frameSizeInMbs = widthInMbs * heightInMbs;
  // A.3.1 h/i: neither side may exceed sqrt(8 * MaxFS), so a very wide or
  // very tall frame needs a higher level than its area alone suggests.
  const maxSideInMbs = Math.sqrt(level.maxFs * 8);
  return frameSizeInMbs <= level.maxFs
    && widthInMbs <= maxSideInMbs
    && heightInMbs <= maxSideInMbs
    && frameSizeInMbs * fps <= level.maxMbps
    && bitrate <= level.maxBr * 1000;
}

/**
 * The lowest level whose limits hold a stream of this size, frame rate and
 * bitrate. 1080p fits 4.0 at 30 fps but needs 4.2 at 60 fps; 2160p needs 5.1
 * and 5.2. Anything beyond the table gets the highest level.
 */
export function h264LevelIdc(stream: H264StreamShape): number {
  return (H264_LEVELS.find((level) => fitsLevel(level, stream)) ?? HIGHEST_LEVEL).idc;
}

/**
 * The level Mediabunny 1.50.8 (bundled by @remotion/web-renderer 4.0.509)
 * writes into the codec string it hands to WebCodecs: frame size and bitrate
 * only, never the frame rate. It is reproduced here so a capability probe asks
 * the browser exactly what the render will ask; browserEncoderProbe.verify.ts
 * pins it to the installed Mediabunny.
 */
export function mediabunnyAvcLevelIdc(width: number, height: number, bitrate: number): number {
  const frameSizeInMbs = macroblocks(width) * macroblocks(height);
  return (H264_LEVELS.find((level) => (
    frameSizeInMbs <= level.maxFs && bitrate <= level.maxBr * 1000
  )) ?? HIGHEST_LEVEL).idc;
}

/** `avc1` High profile (0x64), no constraint flags, the given level_idc. */
export function avcHighProfileCodecString(levelIdc: number): string {
  return `avc1.6400${levelIdc.toString(16).padStart(2, '0')}`;
}
