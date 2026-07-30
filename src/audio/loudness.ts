// 响度归一分析核心。命名风格同 isolate_voice(动词_名词)。
//
// 拆两半:纯函数(可在 node 下跑 check,无 DOM 依赖)+ 浏览器专用(fetch+WebAudio 解码)。

// ── 纯函数(node-testable) ──────────────────────────────────────────────

// ponytail: 简化版 BS.1770——用 400ms 分块均方能量 + 绝对静音门限近似积分响度,
// 省略了真正的 K-weighting 预滤波(高架+高通)和相对门限(比未门限响度低10dB的
// 块也应剔除)。对稳态/準稳态素材(语音、音乐)误差通常在几个 LUFS 内,足够当
// "要不要提增益/提多少"的粗判;对含大段静音+突发响度的素材会偏离更多。
// 升级路径:接 K-weighting 双二阶滤波器 + 相对门限,对齐 ITU-R BS.1770-4 全流程。
export function integratedLoudnessFromSamples(samples: Float32Array, sampleRate: number): number {
  if (samples.length === 0 || sampleRate <= 0) return -70; // 空/非法输入 → 静音下限,不返回 NaN
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4)); // BS.1770 gating block = 400ms
  const blockMeanSquares: number[] = [];
  for (let start = 0; start < samples.length; start += blockSize) {
    const end = Math.min(start + blockSize, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    blockMeanSquares.push(sum / (end - start));
  }
  // BS.1770 绝对门限对应的均方阈值(-70 LUFS 以下的块视为静音,不计入平均)
  const ABSOLUTE_GATE_MS = 10 ** ((-70 + 0.691) / 10);
  const gated = blockMeanSquares.filter((ms) => ms > ABSOLUTE_GATE_MS);
  const kept = gated.length > 0 ? gated : blockMeanSquares; // 全静音时退化为用全部块,避免空数组
  const meanSquare = kept.reduce((a, b) => a + b, 0) / kept.length;
  const EPS = 1e-10; // 防 log10(0) = -Infinity
  return -0.691 + 10 * Math.log10(Math.max(meanSquare, EPS));
}

const MIN_GAIN = 0.05;
const MAX_GAIN = 8;

/** 达到目标响度所需的线性增益倍数,夹在 [MIN_GAIN, MAX_GAIN] 防止炸音/静音。 */
export function gainForTarget(currentLufs: number, targetLufs: number): number {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return 1; // 非法输入 → 增益不变,不让 NaN 扩散
  const gain = 10 ** ((targetLufs - currentLufs) / 20);
  if (!Number.isFinite(gain)) return MAX_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
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

/** 拉取音频源→OfflineAudioContext 离线解码(不出声,不受自动播放策略限制)→混单声道
 * →测积分响度。浏览器专用;node 环境下不该被调到(OfflineAudioContext 不存在)。 */
export async function analyzeClipLoudness(src: string): Promise<number> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  // 长度只是占位;真实采样率/声道数以 decodeAudioData 的解码结果为准。
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return integratedLoudnessFromSamples(mixToMono(audioBuffer), audioBuffer.sampleRate);
}
