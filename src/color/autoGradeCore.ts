export const AUTO_GRADE_LIMITS = {
  brightness: { min: 0.94, max: 1.08 },
  contrast: { min: 0.94, max: 1.08 },
  saturate: { min: 0.94, max: 1.06 },
  hdrDelta: 0.04,
} as const;

export interface ColorStreamProfile {
  bitDepth: number;
  pixelFormat: string;
  colorRange: string;
  colorTransfer: string;
  colorPrimaries: string;
  colorSpace: string;
  hdr: boolean;
}

export interface RawSignalFrame {
  yMin?: number;
  yLow?: number;
  yAverage?: number;
  yHigh?: number;
  yMax?: number;
  saturationAverage?: number;
}

export interface AutoGradeStats {
  sampleCount: number;
  yMean: number;
  yRange: number;
  saturationMean: number;
}

export interface AutoGradeAnalysis {
  profile: ColorStreamProfile;
  stats: AutoGradeStats;
  filters: {
    brightness: number;
    contrast: number;
    saturate: number;
  };
  adjustments: string[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const average = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function inferBitDepth(stream: {
  bits_per_raw_sample?: string | number | null;
  pix_fmt?: string | null;
}): number {
  const explicit = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(explicit) && explicit >= 8 && explicit <= 16) return Math.round(explicit);
  const pixelFormat = String(stream.pix_fmt ?? '').toLowerCase();
  // Cover both planar suffixes (yuv420p10le, gbrap12le, x2rgb10le) and
  // semi-planar hardware formats (p010le, p210le, p410le).
  const formatDepth = pixelFormat.match(/p[024](10|12|16)(?:le|be)?$/)?.[1]
    ?? pixelFormat.match(/(?:^|[^0-9])(9|10|12|14|16)(?:le|be)?$/)?.[1];
  const parsed = Number(formatDepth);
  return Number.isFinite(parsed) ? parsed : 8;
}

export function isHdrTransfer(colorTransfer: string | null | undefined): boolean {
  const transfer = String(colorTransfer ?? '').toLowerCase();
  return transfer === 'smpte2084' || transfer === 'arib-std-b67' || transfer === 'hlg';
}

export function createColorStreamProfile(stream: {
  bits_per_raw_sample?: string | number | null;
  pix_fmt?: string | null;
  color_range?: string | null;
  color_transfer?: string | null;
  color_primaries?: string | null;
  color_space?: string | null;
}): ColorStreamProfile {
  const colorTransfer = String(stream.color_transfer ?? 'unknown');
  return {
    bitDepth: inferBitDepth(stream),
    pixelFormat: String(stream.pix_fmt ?? 'unknown'),
    colorRange: String(stream.color_range ?? 'unknown'),
    colorTransfer,
    colorPrimaries: String(stream.color_primaries ?? 'unknown'),
    colorSpace: String(stream.color_space ?? 'unknown'),
    hdr: isHdrTransfer(colorTransfer),
  };
}

/** FFmpeg signalstats reports native code values (8-bit 0..255, 10-bit 0..1023). */
export function normalizeSignalValue(value: number, bitDepth: number): number {
  const safeDepth = clamp(Math.round(bitDepth || 8), 8, 16);
  return clamp(value / ((2 ** safeDepth) - 1), 0, 1);
}

export function summarizeSignalFrames(
  frames: RawSignalFrame[],
  profile: Pick<ColorStreamProfile, 'bitDepth'>,
): AutoGradeStats {
  const valid = frames.filter((frame) => Number.isFinite(frame.yAverage));
  if (!valid.length) {
    return { sampleCount: 0, yMean: 0.5, yRange: 0.72, saturationMean: 0.25 };
  }
  const norm = (value: number | undefined): number | null =>
    Number.isFinite(value) ? normalizeSignalValue(Number(value), profile.bitDepth) : null;
  const yMean = average(valid.map((frame) => norm(frame.yAverage) ?? 0.5));
  const ranges = valid.map((frame) => {
    const low = norm(frame.yLow ?? frame.yMin);
    const high = norm(frame.yHigh ?? frame.yMax);
    return low === null || high === null ? null : Math.max(0, high - low);
  }).filter((value): value is number => value !== null);
  const saturation = valid.map((frame) => norm(frame.saturationAverage))
    .filter((value): value is number => value !== null);
  return {
    sampleCount: valid.length,
    yMean,
    yRange: ranges.length ? average(ranges) : 0.72,
    saturationMean: saturation.length ? average(saturation) : 0.25,
  };
}

function boundForHdr(value: number, hdr: boolean): number {
  return hdr ? clamp(value, 1 - AUTO_GRADE_LIMITS.hdrDelta, 1 + AUTO_GRADE_LIMITS.hdrDelta) : value;
}

/**
 * Technical cleanup only: small neutral brightness/contrast/saturation corrections.
 * Creative looks and LUTs remain explicit user choices.
 */
export function recommendAutoGrade(
  stats: AutoGradeStats,
  profile: Pick<ColorStreamProfile, 'hdr'>,
): Pick<AutoGradeAnalysis, 'filters' | 'adjustments'> {
  let contrast = 1.03;
  if (stats.yRange < 0.65) {
    const t = clamp((stats.yRange - 0.5) / 0.15, 0, 1);
    contrast = 1.08 - (0.05 * t);
  }

  let brightness = 1;
  if (stats.yMean < 0.42) {
    const t = clamp((stats.yMean - 0.3) / 0.12, 0, 1);
    brightness = 1.08 - (0.06 * t);
  } else if (stats.yMean > 0.6) {
    brightness = 0.97;
  }

  let saturate = 0.98;
  if (stats.saturationMean < 0.18) saturate = 1.04;
  else if (stats.saturationMean > 0.38) saturate = 0.96;

  brightness = boundForHdr(
    clamp(brightness, AUTO_GRADE_LIMITS.brightness.min, AUTO_GRADE_LIMITS.brightness.max),
    profile.hdr,
  );
  contrast = boundForHdr(
    clamp(contrast, AUTO_GRADE_LIMITS.contrast.min, AUTO_GRADE_LIMITS.contrast.max),
    profile.hdr,
  );
  saturate = boundForHdr(
    clamp(saturate, AUTO_GRADE_LIMITS.saturate.min, AUTO_GRADE_LIMITS.saturate.max),
    profile.hdr,
  );

  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const filters = {
    brightness: round(brightness),
    contrast: round(contrast),
    saturate: round(saturate),
  };
  const adjustments: string[] = [];
  if (filters.brightness > 1.005) adjustments.push('lift-exposure');
  else if (filters.brightness < 0.995) adjustments.push('reduce-exposure');
  if (filters.contrast > 1.005) adjustments.push('increase-contrast');
  else if (filters.contrast < 0.995) adjustments.push('reduce-contrast');
  if (filters.saturate > 1.005) adjustments.push('increase-saturation');
  else if (filters.saturate < 0.995) adjustments.push('reduce-saturation');
  return { filters, adjustments };
}

export function analyzeSignalFrames(
  frames: RawSignalFrame[],
  profile: ColorStreamProfile,
): AutoGradeAnalysis {
  const stats = summarizeSignalFrames(frames, profile);
  return { profile, stats, ...recommendAutoGrade(stats, profile) };
}
