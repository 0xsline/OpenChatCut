// Loudness normalization analysis core. The naming style is the same as isolate_voice(verb_noun).
//
// Split into two halves: pure function (can run check under node, no DOM dependencies) + browser-specific (fetch+WebAudio decoding).

// ── Pure function (node-testable) ───────────────────────────────────────────

// ponytail: Simplified version of BS.1770 - approximate integrated loudness using 400ms block mean square energy + absolute silence threshold,
// Omits true K-weighting pre-filtering (high shelf + high pass) and relative gate (10dB lower than ungated loudness)
// blocks should also be removed). For steady/quasi-steady materials (speech, music) the error is usually within a few LUFS, which is sufficient
// A rough judgment on "whether to increase gain/how much to increase"; the deviation will be greater for materials containing large sections of silence + sudden loudness.
// Upgrade path: Connect K-weighting biquad filter + relative threshold, align with ITU-R BS.1770-4 full process.
export function integratedLoudnessFromSamples(samples: Float32Array, sampleRate: number): number {
  if (samples.length === 0 || sampleRate <= 0) return -70; // Empty/illegal input → mute lower limit, do not return NaN
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4)); // BS.1770 gating block = 400ms
  const blockMeanSquares: number[] = [];
  for (let start = 0; start < samples.length; start += blockSize) {
    const end = Math.min(start + blockSize, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    blockMeanSquares.push(sum / (end - start));
  }
  // Mean square threshold corresponding to BS.1770 absolute threshold (blocks below -70 LUFS are considered silent and are not included in the average)
  const ABSOLUTE_GATE_MS = 10 ** ((-70 + 0.691) / 10);
  const gated = blockMeanSquares.filter((ms) => ms > ABSOLUTE_GATE_MS);
  const kept = gated.length > 0 ? gated : blockMeanSquares; // When fully silent, it degenerates to use all blocks to avoid empty arrays.
  const meanSquare = kept.reduce((a, b) => a + b, 0) / kept.length;
  const EPS = 1e-10; // Anti log10(0) = -Infinity
  return -0.691 + 10 * Math.log10(Math.max(meanSquare, EPS));
}

const MIN_GAIN = 0.05;
const MAX_GAIN = 8;

/** Linear gain multiple required to achieve target loudness,sandwiched [MIN_GAIN, MAX_GAIN] Prevent popping sound/mute. */
export function gainForTarget(currentLufs: number, targetLufs: number): number {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return 1; // Illegal input → The gain remains unchanged and NaN is not allowed to spread.
  const gain = 10 ** ((targetLufs - currentLufs) / 20);
  if (!Number.isFinite(gain)) return MAX_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}

// ── Browser only (fetch + WebAudio decoding) ─────────────────────────────────

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / numberOfChannels;
  }
  return out;
}

/** Pull audio source→OfflineAudioContext Offline decoding(silent,Not restricted by autoplay policy)→Mix mono
 * →Measure the integrated loudness. Browser only;node The environment should not be adjusted to(OfflineAudioContext does not exist)。 */
export async function analyzeClipLoudness(src: string): Promise<number> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to load audio: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  // The length is just a placeholder; the actual sampling rate/number of channels is subject to the decoding result of decodeAudioData.
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return integratedLoudnessFromSamples(mixToMono(audioBuffer), audioBuffer.sampleRate);
}
