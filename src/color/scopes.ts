// Numerical color grading oscilloscope (inspect_color core): calculate black and white points, overflow, channel average,
// Three-segment color cast, saturation and 30° hue histogram. Pure function, node measurable; get the frame/decoding glue in the tool layer.
// Let Agent "color by numbers": quantify the current picture → change filters/LUT/look in a targeted manner → retest.

export interface ChannelMeans {
  r: number;
  g: number;
  b: number;
}

/** The color shift of a brightness band: warmCool = R−B (>0 is warmer), greenMagenta = G−(R+B)/2 (>0 is greener). */
export interface ColorTilt {
  warmCool: number;
  greenMagenta: number;
}

export interface HueBin {
  /** bin starting angle (0/30/…/330) */
  fromDeg: number;
  label: string;
  /** Proportion 0..1 (weighted by saturation × lightness), all 0 when there is no color in the whole image */
  pct: number;
}

export interface ColorScopeStats {
  sampledPixels: number;
  /** Brightness P1 / P99(0..1) — effective black and white point */
  blackPoint: number;
  whitePoint: number;
  meanLuma: number;
  /** Brightness floor/top pixel ratio 0..1 */
  clippedShadowsPct: number;
  clippedHighlightsPct: number;
  channelMeans: ChannelMeans;
  /** Full image color cast and saturation */
  warmCool: number;
  greenMagenta: number;
  saturationMean: number;
  /** Color cast segmented by brightness (shadows <0.25 / mids / highlights >0.7) */
  tilt: { shadows: ColorTilt; mids: ColorTilt; highlights: ColorTilt };
  hueHistogram: HueBin[];
  /** Main hue labels in descending order (listed only if ≥5%) */
  dominantHues: string[];
}

const HUE_LABELS = [
  'red', 'orange', 'yellow', 'lime', 'green', 'spring',
  'cyan', 'azure', 'blue', 'violet', 'magenta', 'rose',
] as const;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;
const CLIP_LOW = 2 / 255;
const CLIP_HIGH = 253 / 255;

function percentileSorted(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/** RGB(0..1) → Hue angle 0..360 and HSV saturation/lightness. */
function hsv(r: number, g: number, b: number): { hueDeg: number; sat: number; val: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const val = max;
  const sat = max === 0 ? 0 : delta / max;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hueDeg: hue, sat, val };
}

/**
 * Analyze a frame of RGBA pixels (Uint8, 4 channels continuous). sampleStep sampling at intervals (default automatic:
 * Target ≤ 120,000 samples), which is sufficient for statistics and saves an order of magnitude of time.
 */
export function analyzeRgbaPixels(
  data: Uint8Array | Uint8ClampedArray,
  sampleStep?: number,
): ColorScopeStats {
  const pixelCount = Math.floor(data.length / 4);
  if (pixelCount === 0) {
    const zeroTilt = { warmCool: 0, greenMagenta: 0 };
    return {
      sampledPixels: 0, blackPoint: 0, whitePoint: 0, meanLuma: 0,
      clippedShadowsPct: 0, clippedHighlightsPct: 0,
      channelMeans: { r: 0, g: 0, b: 0 }, warmCool: 0, greenMagenta: 0, saturationMean: 0,
      tilt: { shadows: zeroTilt, mids: { ...zeroTilt }, highlights: { ...zeroTilt } },
      hueHistogram: HUE_LABELS.map((label, i) => ({ fromDeg: i * 30, label, pct: 0 })),
      dominantHues: [],
    };
  }
  const step = Math.max(1, sampleStep ?? Math.ceil(pixelCount / 120_000));

  let n = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;
  let clippedLow = 0;
  let clippedHigh = 0;
  const lumas: number[] = [];
  const hueWeights = new Float64Array(12);
  let hueWeightTotal = 0;
  const bands = {
    shadows: { r: 0, g: 0, b: 0, n: 0 },
    mids: { r: 0, g: 0, b: 0, n: 0 },
    highlights: { r: 0, g: 0, b: 0, n: 0 },
  };

  for (let p = 0; p < pixelCount; p += step) {
    const i = p * 4;
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    n += 1;
    sumR += r;
    sumG += g;
    sumB += b;
    lumas.push(luma);
    if (luma <= CLIP_LOW) clippedLow += 1;
    if (luma >= CLIP_HIGH) clippedHigh += 1;
    const { hueDeg, sat, val } = hsv(r, g, b);
    sumSat += sat;
    const weight = sat * val;
    if (weight > 0.02) {
      hueWeights[Math.min(11, Math.floor(hueDeg / 30))] += weight;
      hueWeightTotal += weight;
    }
    const band = luma < 0.25 ? bands.shadows : luma > 0.7 ? bands.highlights : bands.mids;
    band.r += r;
    band.g += g;
    band.b += b;
    band.n += 1;
  }

  const sortedLuma = new Float32Array(lumas).sort();
  const tiltOf = (band: { r: number; g: number; b: number; n: number }): ColorTilt =>
    band.n === 0
      ? { warmCool: 0, greenMagenta: 0 }
      : {
        warmCool: (band.r - band.b) / band.n,
        greenMagenta: (band.g - (band.r + band.b) / 2) / band.n,
      };
  const hueHistogram: HueBin[] = HUE_LABELS.map((label, i) => ({
    fromDeg: i * 30,
    label,
    pct: hueWeightTotal > 0 ? hueWeights[i]! / hueWeightTotal : 0,
  }));
  const dominantHues = [...hueHistogram]
    .filter((bin) => bin.pct >= 0.05)
    .sort((a, b) => b.pct - a.pct)
    .map((bin) => bin.label);

  return {
    sampledPixels: n,
    blackPoint: percentileSorted(sortedLuma, 0.01),
    whitePoint: percentileSorted(sortedLuma, 0.99),
    meanLuma: sortedLuma.length ? lumas.reduce((a, v) => a + v, 0) / n : 0,
    clippedShadowsPct: clippedLow / n,
    clippedHighlightsPct: clippedHigh / n,
    channelMeans: { r: sumR / n, g: sumG / n, b: sumB / n },
    warmCool: (sumR - sumB) / n,
    greenMagenta: (sumG - (sumR + sumB) / 2) / n,
    saturationMean: sumSat / n,
    tilt: { shadows: tiltOf(bands.shadows), mids: tiltOf(bands.mids), highlights: tiltOf(bands.highlights) },
    hueHistogram,
    dominantHues,
  };
}

/** Compress statistics into a few lines for LLM's readable interpretation (definitive copy, no recommendations, just facts). */
export function describeScopeStats(s: ColorScopeStats): string[] {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `luma: black ${s.blackPoint.toFixed(3)} · mean ${s.meanLuma.toFixed(3)} · white ${s.whitePoint.toFixed(3)}`,
    `clipping: shadows ${pct(s.clippedShadowsPct)} · highlights ${pct(s.clippedHighlightsPct)}`,
    `balance: warm-cool ${s.warmCool >= 0 ? '+' : ''}${s.warmCool.toFixed(3)} (R−B) · green-magenta ${s.greenMagenta >= 0 ? '+' : ''}${s.greenMagenta.toFixed(3)} · saturation ${s.saturationMean.toFixed(3)}`,
  ];
  if (s.dominantHues.length) {
    const top = s.hueHistogram.filter((bin) => bin.pct >= 0.05).sort((a, b) => b.pct - a.pct)
      .map((bin) => `${bin.label} ${pct(bin.pct)}`).join(', ');
    lines.push(`dominant hues: ${top}`);
  } else {
    lines.push('dominant hues: none (near-neutral image)');
  }
  return lines;
}
