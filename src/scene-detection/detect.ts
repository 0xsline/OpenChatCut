export type SceneChangeKind = 'cut' | 'transition';

export interface RawSceneCandidate {
  timeMs: number;
  score: number;
}

export interface SceneChange extends RawSceneCandidate {
  kind: SceneChangeKind;
}

export interface NormalizeSceneOptions {
  threshold: number;
  minSceneMs: number;
  durationMs?: number;
  maxScenes?: number;
}

export const DEFAULT_SCENE_THRESHOLD = 0.3;
export const DEFAULT_MIN_SCENE_MS = 750;
export const DEFAULT_MAX_SCENES = 200;

export function normalizeSceneThreshold(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SCENE_THRESHOLD;
  return Math.min(0.95, Math.max(0.05, parsed));
}

/** Parse FFmpeg metadata=print output into scored source-time candidates. */
export function parseSceneMetadata(text: string): RawSceneCandidate[] {
  const candidates: RawSceneCandidate[] = [];
  let timeMs: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const time = /\bpts_time:([-+\d.eE]+)/.exec(line);
    if (time) {
      const seconds = Number(time[1]);
      timeMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
      continue;
    }
    const score = /\blavfi\.scene_score=([-+\d.eE]+)/.exec(line);
    if (!score || timeMs === null) continue;
    const value = Number(score[1]);
    if (Number.isFinite(value)) candidates.push({ timeMs, score: value });
    timeMs = null;
  }
  return candidates;
}

function classify(score: number, threshold: number): SceneChangeKind {
  const hardCutScore = Math.max(0.4, threshold * 1.25);
  return score + Number.EPSILON >= hardCutScore ? 'cut' : 'transition';
}

/**
 * Sort, sanitize and de-bounce scene candidates. Candidates closer than
 * minSceneMs compete by score so a short flash cannot create several cuts.
 */
export function normalizeSceneCandidates(
  input: readonly RawSceneCandidate[],
  options: NormalizeSceneOptions,
): SceneChange[] {
  const threshold = normalizeSceneThreshold(options.threshold);
  const minSceneMs = Math.max(100, Math.round(options.minSceneMs));
  const durationMs = Number.isFinite(options.durationMs)
    ? Math.max(0, Math.round(options.durationMs!))
    : Number.POSITIVE_INFINITY;
  const maxScenes = Math.max(1, Math.min(500, Math.round(options.maxScenes ?? DEFAULT_MAX_SCENES)));
  const sorted = input
    .filter((candidate) => (
      Number.isFinite(candidate.timeMs)
      && Number.isFinite(candidate.score)
      && candidate.score >= threshold
      && candidate.timeMs >= minSceneMs
      && candidate.timeMs <= durationMs - minSceneMs
    ))
    .map((candidate) => ({ timeMs: Math.round(candidate.timeMs), score: candidate.score }))
    .sort((a, b) => a.timeMs - b.timeMs || b.score - a.score);

  const merged: RawSceneCandidate[] = [];
  for (const candidate of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || candidate.timeMs - previous.timeMs >= minSceneMs) {
      merged.push(candidate);
    } else if (candidate.score > previous.score) {
      merged[merged.length - 1] = candidate;
    }
  }

  return merged.slice(0, maxScenes).map((candidate) => ({
    ...candidate,
    kind: classify(candidate.score, threshold),
  }));
}
