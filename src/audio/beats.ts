// Beat detection core (detect_beats): spectral flux onset envelope → autocorrelation fixed BPM (for frequency doubling
// log-Gaussian preference suppression) → phase fitting to equidistant beat grid → 4/4 accent heuristic to pick downbeats.
// Pure DSP, zero model dependence, node testable; suitable for soundtracks/BGM with a stable rhythm (please segment the variable speed tracks).
// The splitting style is the same as loudness/silence: pure function + browser decoding glue.

export interface BeatAnalysis {
  /** 0 = No credible beat detected */
  bpm: number;
  /** The multiple of the autocorrelation peak relative to the mean value; ≥2 is considered credible, and below 1.2 is basically unrhythmic asset */
  confidence: number;
  /** Beat time (source seconds, equidistant grid) */
  beats: number[];
  /** The first beat of each measure (4/4 heuristic, accent phase) */
  downbeats: number[];
}

const FFT_SIZE = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;
/** No beat will be generated if the reliability is lower than this (voice/ambient sound gatekeeping) */
const MIN_CONFIDENCE = 1.2;

/** Iterate over in-place radix-2 FFT (internal use only, length must be a power of 2). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tRe = re[b]! * curRe - im[b]! * curIm;
        const tIm = re[b]! * curIm + im[b]! * curRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Spectral flux onset envelope: frame length 1024/hop 512, half-wave rectification + 0.5s sliding mean detrending. */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): { env: Float64Array; hopSeconds: number } {
  const hopSeconds = HOP / sampleRate;
  const frames = Math.floor((samples.length - FFT_SIZE) / HOP);
  if (frames <= 2) return { env: new Float64Array(0), hopSeconds };
  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  const bins = FFT_SIZE / 2;
  const prevMag = new Float64Array(bins);
  const flux = new Float64Array(frames);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let t = 0; t < frames; t++) {
    const at = t * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[at + i]! * hann[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      const rise = mag - prevMag[k]!;
      if (rise > 0) sum += rise;
      prevMag[k] = mag;
    }
    flux[t] = t === 0 ? 0 : sum;
  }
  // De-trend: subtract 0.5s from the sliding mean and then rectify it by half wave to highlight the transient and suppress the continuous energy.
  const half = Math.max(1, Math.round(0.25 / hopSeconds));
  const env = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    const from = Math.max(0, t - half);
    const to = Math.min(frames - 1, t + half);
    let mean = 0;
    for (let i = from; i <= to; i++) mean += flux[i]!;
    mean /= to - from + 1;
    env[t] = Math.max(0, flux[t]! - mean);
  }
  return { env, hopSeconds };
}

interface TempoEstimate {
  bpm: number;
  periodHops: number;
  confidence: number;
}

/** Autocorrelation fixed BPM: 60..180 sweep, log2-Gaussian (center 120) pressure multiplication; peak parabolic refinement. */
export function estimateTempo(env: Float64Array, hopSeconds: number): TempoEstimate | null {
  const minLag = Math.max(2, Math.floor(60 / MAX_BPM / hopSeconds));
  const maxLag = Math.ceil(60 / MIN_BPM / hopSeconds);
  if (env.length < maxLag * 2) return null;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = env.length - lag;
    for (let t = 0; t < n; t++) sum += env[t]! * env[t + lag]!;
    ac[lag] = sum / n;
  }
  let acMean = 0;
  for (let lag = minLag; lag <= maxLag; lag++) acMean += ac[lag]!;
  acMean /= maxLag - minLag + 1;
  if (acMean <= 0) return null;

  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSeconds);
    const octaves = Math.log2(bpm / 120);
    const weight = Math.exp(-0.5 * (octaves / 0.6) ** 2);
    const score = ac[lag]! * weight;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  // Parabolic refinement sub-hop period
  let period = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = ac[bestLag - 1]!;
    const y1 = ac[bestLag]!;
    const y2 = ac[bestLag + 1]!;
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) period = bestLag + 0.5 * ((y0 - y2) / denom);
  }
  return {
    bpm: 60 / (period * hopSeconds),
    periodHops: period,
    confidence: ac[bestLag]! / acMean,
  };
}

/** Phase fitting: Sweep the offset within a cycle, take the envelope sample and the largest equidistant grid (hop units). */
export function fitBeatGrid(env: Float64Array, periodHops: number): number[] {
  if (env.length === 0 || !(periodHops > 1)) return [];
  const sample = (x: number): number => {
    const i = Math.floor(x);
    if (i < 0 || i >= env.length - 1) return i === env.length - 1 ? env[i]! : 0;
    const frac = x - i;
    return env[i]! * (1 - frac) + env[i + 1]! * frac;
  };
  const steps = 64;
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const offset = (s / steps) * periodHops;
    let score = 0;
    for (let x = offset; x < env.length; x += periodHops) score += sample(x);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  const beats: number[] = [];
  for (let x = bestOffset; x < env.length; x += periodHops) beats.push(x);
  return beats;
}

/** 4/4 accent heuristic: Among the four bar phases, the group with the largest beat point envelope is the downbeat. */
export function pickDownbeats(env: Float64Array, beatsHops: readonly number[]): number[] {
  if (beatsHops.length < 4) return [];
  const at = (x: number): number => env[Math.min(env.length - 1, Math.max(0, Math.round(x)))]!;
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let score = 0;
    for (let i = phase; i < beatsHops.length; i += 4) score += at(beatsHops[i]!);
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return beatsHops.filter((_, i) => (i - bestPhase) % 4 === 0 && i >= bestPhase);
}

/** One-stop: PCM → BeatAnalysis(source seconds). Rhythmic/arrhythmic asset returns bpm 0 + empty beat. */
export function analyzeBeats(samples: Float32Array, sampleRate: number): BeatAnalysis {
  const none: BeatAnalysis = { bpm: 0, confidence: 0, beats: [], downbeats: [] };
  if (samples.length < sampleRate * 4 || sampleRate <= 0) return none;
  const { env, hopSeconds } = onsetEnvelope(samples, sampleRate);
  const tempo = estimateTempo(env, hopSeconds);
  if (!tempo) return none;
  if (tempo.confidence < MIN_CONFIDENCE) return { ...none, confidence: Math.round(tempo.confidence * 100) / 100 };
  const beatsHops = fitBeatGrid(env, tempo.periodHops);
  const downbeatHops = pickDownbeats(env, beatsHops);
  const toSeconds = (hops: number): number => Math.round(hops * hopSeconds * 1000) / 1000;
  return {
    bpm: Math.round(tempo.bpm * 10) / 10,
    confidence: Math.round(tempo.confidence * 100) / 100,
    beats: beatsHops.map(toSeconds),
    downbeats: downbeatHops.map(toSeconds),
  };
}

// ── Browser-specific (fetch + WebAudio decoding, splitting style is the same as loudness/silence) ──────────

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / numberOfChannels;
  }
  return out;
}

/** Pull source → offline decoding → mix mono → beat analysis (source seconds). Browser only. */
export async function analyzeAssetBeats(src: string): Promise<BeatAnalysis> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return analyzeBeats(mixToMono(audioBuffer), audioBuffer.sampleRate);
}
