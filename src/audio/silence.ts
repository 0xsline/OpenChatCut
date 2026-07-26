// 静音死气检测核心(remove_silence)。命名风格同 loudness(纯函数 + 浏览器专用拆分)。
//
// 检测语义:
//   死气 = 电平显著低于「这段录音自己的语音电平」的连续非语音段。
//   参照电平取窗口 RMS 的高分位(默认 P90),阈值 = 参照 + thresholdDb(默认 -26dB),
//   再叠一道绝对下限(-35dBFS):两者都低于才算静。相对阈值保证音乐床/响环境音
//   不被切;参照本身低于 -45dBFS 视为"整段没有语音",直接不出段。
//   边界各留 padMs 呼吸口,短于 minSilenceMs 的间隙不动。

// ── 纯函数(node-testable) ──────────────────────────────────────────────

export interface SilenceSpan {
  /** 源媒体毫秒(相对被分析音频的 0 点) */
  startMs: number;
  endMs: number;
}

export interface SilenceParams {
  /** 相对语音参照电平的判静阈值(dB,默认 -26;更负 = 更保守) */
  thresholdDb?: number;
  /** 只删至少这么长的静段(ms,默认 600) */
  minSilenceMs?: number;
  /** 每侧保留的呼吸口(ms,默认 150) */
  padMs?: number;
}

export const SILENCE_DEFAULTS: Required<SilenceParams> = {
  thresholdDb: -26,
  minSilenceMs: 600,
  padMs: 150,
};

/** 整段录音没有可信语音参照时的判定下限(dBFS)。 */
const SPEECH_FLOOR_DB = -45;
/** 相对阈值之外的绝对判静上限(dBFS):再怎么"相对低",高于它就不算静。 */
const ABSOLUTE_SILENCE_DB = -35;

const toDb = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-8));

/** 窗口化 RMS 包络(不重叠 hop = windowMs)。 */
export function rmsEnvelope(samples: Float32Array, sampleRate: number, windowMs = 50): Float32Array {
  if (samples.length === 0 || sampleRate <= 0 || windowMs <= 0) return new Float32Array(0);
  const win = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const out = new Float32Array(Math.ceil(samples.length / win));
  for (let w = 0; w < out.length; w++) {
    const start = w * win;
    const end = Math.min(start + win, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    out[w] = Math.sqrt(sum / (end - start));
  }
  return out;
}

function percentileDb(env: Float32Array, p: number): number {
  const sorted = [...env].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return toDb(sorted[idx] ?? 0);
}

/** 从 RMS 包络找死气段(源毫秒)。 */
export function detectSilentSpans(
  env: Float32Array,
  windowMs: number,
  params: SilenceParams = {},
): SilenceSpan[] {
  if (env.length === 0 || windowMs <= 0) return [];
  const thresholdDb = params.thresholdDb ?? SILENCE_DEFAULTS.thresholdDb;
  const minSilenceMs = params.minSilenceMs ?? SILENCE_DEFAULTS.minSilenceMs;
  const padMs = params.padMs ?? SILENCE_DEFAULTS.padMs;

  const speechRefDb = percentileDb(env, 0.9);
  if (speechRefDb < SPEECH_FLOOR_DB) return []; // 整段没有语音参照(纯静/纯底噪)→ 不动
  const gateDb = Math.min(speechRefDb + thresholdDb, ABSOLUTE_SILENCE_DB);

  const spans: SilenceSpan[] = [];
  let runStart = -1;
  for (let w = 0; w <= env.length; w++) {
    const silent = w < env.length && toDb(env[w]!) < gateDb;
    if (silent && runStart < 0) runStart = w;
    if (!silent && runStart >= 0) {
      const startMs = runStart * windowMs + padMs;
      const endMs = w * windowMs - padMs;
      if (endMs - startMs >= minSilenceMs - 2 * padMs && endMs - startMs > 0
        && w * windowMs - runStart * windowMs >= minSilenceMs) {
        spans.push({ startMs, endMs });
      }
      runStart = -1;
    }
  }
  return spans;
}

// ── 浏览器专用(fetch + WebAudio 解码) ──────────────────────────────────

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / numberOfChannels;
  }
  return out;
}

const ENVELOPE_WINDOW_MS = 50;

/** 拉源→离线解码→混单声道→包络→死气段(源毫秒)。浏览器专用。 */
export async function analyzeClipSilence(src: string, params: SilenceParams = {}): Promise<SilenceSpan[]> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  const env = rmsEnvelope(mixToMono(audioBuffer), audioBuffer.sampleRate, ENVELOPE_WINDOW_MS);
  return detectSilentSpans(env, ENVELOPE_WINDOW_MS, params);
}
