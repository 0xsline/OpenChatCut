// Pure audio alignment (DOM-free): cross-correlate two
// mono signals and return the lag that best lines them up.
// lagSamples > 0 → `other` content peaks later than `ref` → start other earlier on the timeline.

const TARGET_RATE = 4_000; // coarse rate for speed; ±1 sample ≈ 0.25ms
const MAX_LAG_SEC = 90;    // search window ±90s (multicam clock skew)
const MAX_SIGNAL_SEC = 45; // only correlate the first N seconds (enough for a match)

/** Mix AudioBuffer-like channel data to mono Float32Array at the given rate. */
export function mixToMono(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!.subarray(0, length);
  const out = new Float32Array(length);
  const n = channels.length;
  for (let i = 0; i < length; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i] ?? 0;
    out[i] = s / n;
  }
  return out;
}

/** Linear resample mono samples from `srcRate` → `targetRate` (default 4 kHz). */
export function downsample(samples: Float32Array, srcRate: number, targetRate = TARGET_RATE): Float32Array {
  if (srcRate <= 0 || samples.length === 0) return new Float32Array(0);
  if (Math.abs(srcRate - targetRate) < 1) return samples;
  const ratio = srcRate / targetRate;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = samples[i0]! * (1 - t) + samples[i1]! * t;
  }
  return out;
}

/** Zero-mean the signal (DC offset kills correlation peaks). */
export function removeDc(samples: Float32Array): Float32Array {
  if (!samples.length) return samples;
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i]!;
  mean /= samples.length;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! - mean;
  return out;
}

export interface AlignResult {
  /** samples of `other` relative to `ref` at `sampleRate` (other delayed when > 0) */
  lagSamples: number;
  lagSeconds: number;
  /** 0..1-ish peak strength (normalized by energies); low → unreliable */
  confidence: number;
  sampleRate: number;
}

/**
 * Find lag of `other` vs `ref` via multi-resolution normalized cross-correlation.
 * lag > 0 → template matches later in `other` → other is delayed relative to ref.
 *
 * 1) Coarse: further downsample (~200 Hz) and full lag search (cheap)
 * 2) Fine: refine ±1 coarse step at full rate
 */
export function findLag(ref: Float32Array, other: Float32Array, sampleRate = TARGET_RATE): AlignResult {
  if (ref.length < 64 || other.length < 64 || sampleRate <= 0) {
    return { lagSamples: 0, lagSeconds: 0, confidence: 0, sampleRate };
  }
  const maxSamples = Math.floor(MAX_SIGNAL_SEC * sampleRate);
  const aFull = removeDc(ref.length > maxSamples ? ref.subarray(0, maxSamples) : ref);
  const bFull = removeDc(other.length > maxSamples ? other.subarray(0, maxSamples) : other);

  const coarseRate = 200;
  const aC = downsample(aFull, sampleRate, coarseRate);
  const bC = downsample(bFull, sampleRate, coarseRate);
  const coarse = matchTemplate(aC, bC, Math.floor(MAX_LAG_SEC * coarseRate));
  if (coarse.confidence <= 0) {
    return { lagSamples: 0, lagSeconds: 0, confidence: 0, sampleRate };
  }

  // Map coarse lag to fine sample index, refine locally
  const scale = sampleRate / coarseRate;
  const roughLag = Math.round(coarse.lagSamples * scale);
  const maxLag = Math.floor(MAX_LAG_SEC * sampleRate);
  const window = Math.ceil(scale) + 2;
  const fine = matchTemplate(aFull, bFull, maxLag, {
    lagMin: Math.max(-maxLag, roughLag - window),
    lagMax: Math.min(maxLag, roughLag + window),
  });

  return {
    lagSamples: fine.lagSamples,
    lagSeconds: fine.lagSamples / sampleRate,
    confidence: fine.confidence,
    sampleRate,
  };
}

/** Slide a template from `ref` over `other`; optional lag range clamp. */
function matchTemplate(
  ref: Float32Array,
  other: Float32Array,
  maxLag: number,
  range?: { lagMin: number; lagMax: number },
): { lagSamples: number; confidence: number } {
  const tplLen = Math.min(
    Math.floor(ref.length * 0.5),
    Math.max(32, Math.floor(other.length * 0.5)),
  );
  if (tplLen < 32) return { lagSamples: 0, confidence: 0 };
  const tplStart = Math.max(0, Math.floor((ref.length - tplLen) / 3));
  const tpl = ref.subarray(tplStart, tplStart + tplLen);
  let eT = 0;
  for (let i = 0; i < tpl.length; i++) eT += tpl[i]! * tpl[i]!;
  if (eT < 1e-12) return { lagSamples: 0, confidence: 0 };

  const sMin = Math.max(0, tplStart + (range?.lagMin ?? -maxLag));
  const sMax = Math.min(other.length - tpl.length, tplStart + (range?.lagMax ?? maxLag));
  if (sMax < sMin) return { lagSamples: 0, confidence: 0 };

  let bestS = sMin;
  let bestScore = -Infinity;
  for (let s = sMin; s <= sMax; s++) {
    let sum = 0;
    let eB = 0;
    for (let i = 0; i < tpl.length; i++) {
      const v = other[s + i]!;
      sum += tpl[i]! * v;
      eB += v * v;
    }
    if (eB < 1e-12) continue;
    const sc = sum / Math.sqrt(eT * eB);
    if (sc > bestScore) {
      bestScore = sc;
      bestS = s;
    }
  }
  return {
    lagSamples: bestS - tplStart,
    confidence: Math.max(0, Math.min(1, bestScore === -Infinity ? 0 : bestScore)),
  };
}

/** Prepare mono 4 kHz float samples from channel data + rate. */
export function prepareSignal(channels: Float32Array[], length: number, srcRate: number): Float32Array {
  return downsample(mixToMono(channels, length), srcRate, TARGET_RATE);
}

export { TARGET_RATE };
