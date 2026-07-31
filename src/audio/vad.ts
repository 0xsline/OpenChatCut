import {
  loadVadEvidence,
  saveVadEvidence,
  type VadEvidence,
  type VadEvidenceKey,
  type VadTimeSpan,
} from '../persist/vadEvidenceStore';
import type { SilenceSpan } from './silence';

export const VAD_MODEL = 'silero-vad';
export const VAD_MODEL_VERSION = 'silero-vad-onnx-v5';
export const VAD_MIN_CONFIDENCE = 0.65;

export interface VadRunResult {
  speechSpans: VadTimeSpan[];
  confidence: number;
}

export type VadRunner = (
  samples: Float32Array,
  sampleRate: number,
  threshold: number,
  signal?: AbortSignal,
) => Promise<VadRunResult>;

export type VadEvidenceResult =
  | { status: 'ready'; evidence: VadEvidence; cached: boolean }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

let registeredRunner: VadRunner | undefined;

/** Optional model adapter registration. Absence is explicit and never interpreted as silence. */
export function registerVadRunner(runner: VadRunner | undefined): void {
  registeredRunner = runner;
}

export function vadSilenceRemovalEnabled(
  value: unknown = import.meta.env?.VITE_ENABLE_VAD_SILENCE_REMOVAL,
): boolean {
  return value === true || value === 'true' || value === '1';
}

export async function obtainVadEvidence(
  key: VadEvidenceKey,
  samples: Float32Array,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<VadEvidenceResult> {
  const cached = await loadVadEvidence(key);
  if (cached) return { status: 'ready', evidence: cached, cached: true };
  if (!registeredRunner) return { status: 'unavailable', reason: 'VAD model is unavailable' };
  try {
    const result = await registeredRunner(samples, sampleRate, key.threshold, signal);
    if (!Number.isFinite(result.confidence)
      || result.confidence < 0
      || result.confidence > 1
      || !Array.isArray(result.speechSpans)) {
      return { status: 'failed', reason: 'VAD returned invalid evidence' };
    }
    const evidence: VadEvidence = {
      ...key,
      speechSpans: result.speechSpans,
      confidence: result.confidence,
      analyzedAt: Date.now(),
    };
    await saveVadEvidence(evidence);
    return { status: 'ready', evidence, cached: false };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** RMS supplies quiet candidates only. VAD is the sole speech/non-speech evidence. */
export function removableSilenceFromEvidence(
  rmsQuietSpans: readonly SilenceSpan[],
  evidence: VadEvidenceResult | null | undefined,
  options: { featureEnabled: boolean; minConfidence?: number; speechPaddingMs?: number },
): SilenceSpan[] {
  if (!options.featureEnabled || evidence?.status !== 'ready') return [];
  const minimum = options.minConfidence ?? VAD_MIN_CONFIDENCE;
  if (evidence.evidence.confidence < minimum) return [];
  const padding = Math.max(0, options.speechPaddingMs ?? 120);
  const protectedSpeech = evidence.evidence.speechSpans
    .filter((span) => span.confidence >= minimum)
    .map((span) => ({
      startMs: Math.max(0, span.startMs - padding),
      endMs: span.endMs + padding,
    }));
  return rmsQuietSpans.filter((quiet) => !protectedSpeech.some((speech) => (
    quiet.startMs < speech.endMs && quiet.endMs > speech.startMs
  )));
}
