// Sampling configuration for local semantic indexing.
//
// Frame sampling for BOTH web and desktop runs happens in the renderer
// (mediaFrames.ts; the desktop native worker only encodes the sampled
// frames), so tuning these values here covers every runtime.
//
// Persisted in localStorage so tuning survives reloads; defaults mirror the
// original hard-coded constants in mediaFrames.ts. Invalid or missing values
// always fall back to the defaults — bad storage must never break indexing.

export interface SemanticSamplingConfig {
  /** Fallback interval between samples when scene detection is unavailable (seconds). */
  readonly intervalSeconds: number;
  /** Hard cap on fallback-mode sample count (per asset). */
  readonly maxFallbackFrames: number;
  /** Hard cap on scene-aware sample count (per asset). */
  readonly maxSceneFrames: number;
}

export const DEFAULT_SAMPLING_CONFIG: SemanticSamplingConfig = {
  intervalSeconds: 15,
  maxFallbackFrames: 12,
  maxSceneFrames: 96,
};

export const SAMPLING_CONFIG_KEY = 'cc.semanticSamplingConfig';

const INTERVAL_MIN = 1;
const INTERVAL_MAX = 300;
const FRAMES_MIN = 1;
const FRAMES_MAX = 480;

function finiteInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeSamplingConfig(value: unknown): SemanticSamplingConfig {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    intervalSeconds: finiteInt(
      record.intervalSeconds, DEFAULT_SAMPLING_CONFIG.intervalSeconds, INTERVAL_MIN, INTERVAL_MAX,
    ),
    maxFallbackFrames: finiteInt(
      record.maxFallbackFrames, DEFAULT_SAMPLING_CONFIG.maxFallbackFrames, FRAMES_MIN, FRAMES_MAX,
    ),
    maxSceneFrames: finiteInt(
      record.maxSceneFrames, DEFAULT_SAMPLING_CONFIG.maxSceneFrames, FRAMES_MIN, FRAMES_MAX,
    ),
  };
}

export function readSamplingConfig(): SemanticSamplingConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_SAMPLING_CONFIG;
  try {
    const raw = localStorage.getItem(SAMPLING_CONFIG_KEY);
    if (!raw) return DEFAULT_SAMPLING_CONFIG;
    return normalizeSamplingConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_SAMPLING_CONFIG;
  }
}

export function writeSamplingConfig(config: SemanticSamplingConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SAMPLING_CONFIG_KEY, JSON.stringify(normalizeSamplingConfig(config)));
  } catch {
    // Best-effort: in-memory defaults stay active for this session.
  }
}
