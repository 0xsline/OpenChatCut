// Conservative silence-removal core. RMS only proposes acoustically quiet
// candidates; it never decides speech/non-speech. Destructive removal requires
// feature-gated, revision-bound VAD evidence with sufficient confidence.
//
// The RMS reference uses the recording's high-decile level plus an absolute
// ceiling, then applies minimum duration and boundary padding. Music, applause,
// room tone, and low speech remain protected whenever VAD is missing or unsure.

import { sourceRevisionOf } from '../editor/mediaSourceRevision';
import {
  obtainVadEvidence,
  removableSilenceFromEvidence,
  vadSilenceRemovalEnabled,
  VAD_MODEL,
  VAD_MODEL_VERSION,
} from './vad';

// ── Pure function (node-testable) ────────────────────────────────────────────

export interface SilenceSpan {
  /** Source media milliseconds (relative to 0 point of the analyzed audio) */
  startMs: number;
  endMs: number;
}

export interface SilenceParams {
  /** Silence threshold relative to the recording's RMS reference (dB, default -26; more negative = more conservative) */
  thresholdDb?: number;
  /** Only delete static segments that are at least this long (ms, default 600) */
  minSilenceMs?: number;
  /** Breathing ports reserved on each side (ms, default 150) */
  padMs?: number;
}

export interface SilenceAnalysisContext {
  assetId?: string;
  sourceRevision?: string;
  vadThreshold?: number;
  featureEnabled?: boolean;
  signal?: AbortSignal;
}

export const SILENCE_DEFAULTS: Required<SilenceParams> = {
  thresholdDb: -26,
  minSilenceMs: 600,
  padMs: 150,
};

/** Below this dBFS reference the whole recording lacks enough acoustic evidence to classify. */
const SIGNAL_REFERENCE_FLOOR_DB = -45;
/** The absolute upper limit of static determination (dBFS) outside the relative threshold: no matter how "relatively low" it is, anything above it is not considered static. */
const ABSOLUTE_SILENCE_DB = -35;

const toDb = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-8));

/** Windowed RMS envelope (non-overlapping hop = windowMs). */
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

/** Find the dead breath segment (source milliseconds) from the RMS envelope. */
export function detectSilentSpans(
  env: Float32Array,
  windowMs: number,
  params: SilenceParams = {},
): SilenceSpan[] {
  if (env.length === 0 || windowMs <= 0) return [];
  const thresholdDb = params.thresholdDb ?? SILENCE_DEFAULTS.thresholdDb;
  const minSilenceMs = params.minSilenceMs ?? SILENCE_DEFAULTS.minSilenceMs;
  const padMs = params.padMs ?? SILENCE_DEFAULTS.padMs;

  const signalReferenceDb = percentileDb(env, 0.9);
  if (signalReferenceDb < SIGNAL_REFERENCE_FLOOR_DB) return [];
  const gateDb = Math.min(signalReferenceDb + thresholdDb, ABSOLUTE_SILENCE_DB);

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

const ENVELOPE_WINDOW_MS = 50;

/**
 * Pull source → decode → RMS quiet candidates → VAD evidence intersection.
 * The destructive result is empty unless the feature flag is enabled and
 * confident model evidence exists; RMS alone never claims speech/non-speech.
 */
export async function analyzeClipSilence(
  src: string,
  params: SilenceParams = {},
  context: SilenceAnalysisContext = {},
): Promise<SilenceSpan[]> {
  const featureEnabled = context.featureEnabled ?? vadSilenceRemovalEnabled();
  if (!featureEnabled) return [];
  const { installSileroVad } = await import('./silero-vad');
  installSileroVad();
  const res = await fetch(src, { signal: context.signal });
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  const audioContext = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const samples = mixToMono(audioBuffer);
  const rmsQuiet = detectSilentSpans(
    rmsEnvelope(samples, audioBuffer.sampleRate, ENVELOPE_WINDOW_MS),
    ENVELOPE_WINDOW_MS,
    params,
  );
  const sourceRevision = context.sourceRevision ?? sourceRevisionOf({ src });
  const evidence = await obtainVadEvidence({
    assetId: context.assetId ?? `source:${sourceRevision}`,
    sourceRevision,
    model: VAD_MODEL,
    modelVersion: VAD_MODEL_VERSION,
    threshold: Math.max(0, Math.min(1, context.vadThreshold ?? 0.5)),
  }, samples, audioBuffer.sampleRate, context.signal);
  return removableSilenceFromEvidence(rmsQuiet, evidence, {
    featureEnabled,
    speechPaddingMs: params.padMs,
  });
}
