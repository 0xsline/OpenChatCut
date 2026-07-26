// 节拍检测核心(detect_beats):谱通量 onset 包络 → 自相关定 BPM(倍频用
// log-高斯偏好压制)→ 相位拟合出等距节拍网格 → 4/4 重音启发式挑强拍。
// 纯 DSP、零模型依赖,node 可测;适用节奏稳定的配乐/BGM(变速曲目请分段)。
// 拆分风格同 loudness/silence:纯函数 + 浏览器解码胶水。

export interface BeatAnalysis {
  /** 0 = 没检出可信节拍 */
  bpm: number;
  /** 自相关峰相对均值的倍数;≥2 视为可信,1.2 以下基本是无节奏素材 */
  confidence: number;
  /** 节拍时刻(源秒,等距网格) */
  beats: number[];
  /** 每小节第一拍(4/4 启发式,重音相位) */
  downbeats: number[];
}

const FFT_SIZE = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;
/** 低于此可信度不产出节拍(语音/环境声守门) */
const MIN_CONFIDENCE = 1.2;

/** 迭代原地 radix-2 FFT(仅内部用,长度必须是 2 的幂)。 */
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

/** 谱通量 onset 包络:帧长 1024/hop 512,半波整流 + 0.5s 滑动均值去趋势。 */
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
  // 去趋势:减 0.5s 滑动均值再半波整流,突出瞬态、压掉持续能量
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

/** 自相关定 BPM:60..180 扫描,log2-高斯(中心 120)压倍频;峰值抛物线细化。 */
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
  // 抛物线细化亚 hop 周期
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

/** 相位拟合:在一个周期内扫偏移,取包络采样和最大的等距网格(hop 单位)。 */
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

/** 4/4 重音启发式:四种小节相位里,拍点包络和最大的那组是强拍。 */
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

/** 一站式:PCM → BeatAnalysis(源秒)。节奏不稳/无节奏素材返回 bpm 0 + 空拍。 */
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

// ── 浏览器专用(fetch + WebAudio 解码,拆分风格同 loudness/silence) ──────────

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / numberOfChannels;
  }
  return out;
}

/** 拉源→离线解码→混单声道→节拍分析(源秒)。浏览器专用。 */
export async function analyzeAssetBeats(src: string): Promise<BeatAnalysis> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return analyzeBeats(mixToMono(audioBuffer), audioBuffer.sampleRate);
}
