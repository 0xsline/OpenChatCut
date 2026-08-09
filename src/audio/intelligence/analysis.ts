import type { MediaAsset } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { decodeAudioSource } from './audioDecode';
import { analyzeBeatThis } from './beatThisClient';
import { embedMusicAudio } from './clapClient';
import { tagsFromClapEmbedding } from './clapProfile';
import { deriveMusicSections } from './sections';
import { BEAT_THIS_SAMPLE_RATE } from './beatThisPreprocess';
import { MUSIC_ANALYSIS_SCHEMA_VERSION, MUSIC_ANALYZER_FINGERPRINT, MUSIC_MODEL_PACK_FINGERPRINTS } from './types';
import type { BeatThisAnalysis, MusicAnalysis, MusicAnalysisStatus, MusicTag } from './types';
export { MUSIC_ANALYZER_FINGERPRINT, MUSIC_MODEL_PACK_FINGERPRINTS };

const DECODE_SAMPLE_RATE = BEAT_THIS_SAMPLE_RATE;
const MUSIC_TAG_KINDS: Record<MusicTag['kind'], true> = {
  genre: true,
  mood: true,
  instrument: true,
  usage: true,
};


export interface MusicAnalysisProgress {
  phase: Extract<MusicAnalysisStatus, { state: 'running' }>['phase'];
  progress: number;
}

export interface AnalyzeMusicOptions {
  signal?: AbortSignal;
  onProgress?: (progress: MusicAnalysisProgress) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('Music analysis aborted', 'AbortError');
}

function report(options: AnalyzeMusicOptions, phase: MusicAnalysisProgress['phase'], progress: number): void {
  const value = Number.isFinite(progress) ? progress : 0;
  options.onProgress?.({ phase, progress: Math.max(0, Math.min(1, value)) });
}

function normalizeEmbedding(values: readonly number[]): number[] {
  if (values.length !== 512 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('CLAP returned an invalid 512-dimensional embedding');
  }
  let squaredNorm = 0;
  for (const value of values) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm <= 1e-12) throw new Error('CLAP returned a zero embedding');
  return values.map((value) => value / norm);
}

function normalizedTags(tags: readonly MusicTag[]): MusicTag[] {
  return tags
    .filter((tag) => MUSIC_TAG_KINDS[tag.kind] && typeof tag.label === 'string' && tag.label.trim().length > 0 && Number.isFinite(tag.score))
    .slice(0, 64)
    .map((tag) => ({ ...tag, label: tag.label.trim().slice(0, 120), score: Math.max(0, Math.min(1, tag.score)) }));
}

function beatSeries(beatsMs: readonly number[], energy: readonly number[], durationMs: number): {
  beatsMs: number[];
  beatEnergy: number[];
} {
  const times: number[] = [];
  const levels: number[] = [];
  for (let index = 0; index < beatsMs.length; index += 1) {
    const beat = beatsMs[index];
    if (typeof beat !== 'number' || !Number.isFinite(beat) || beat < 0 || beat > durationMs) continue;
    if (times.length && beat <= times[times.length - 1]!) continue;
    const level = energy[index];
    times.push(beat);
    levels.push(typeof level === 'number' && Number.isFinite(level) ? Math.max(0, level) : 0);
  }
  return { beatsMs: times, beatEnergy: levels };
}

function sortedTimes(values: readonly number[], durationMs: number): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > durationMs) continue;
    if (!result.length || value > result[result.length - 1]!) result.push(value);
  }
  return result;
}
function composeMusicAnalysis(
  asset: MediaAsset,
  durationMs: number,
  rhythm: BeatThisAnalysis,
  series: { beatsMs: number[]; beatEnergy: number[] },
  tags: MusicTag[],
  embedding: number[],
): MusicAnalysis {
  return {
    schemaVersion: MUSIC_ANALYSIS_SCHEMA_VERSION,
    assetId: asset.id,
    sourceRevision: sourceRevisionOf(asset),
    createdAt: Date.now(),
    durationMs,
    modelPacks: MUSIC_MODEL_PACK_FINGERPRINTS,
    bpm: Number.isFinite(rhythm.bpm) ? Math.max(0, Math.min(400, rhythm.bpm)) : 0,
    meter: Number.isFinite(rhythm.meter) ? Math.max(1, Math.min(16, Math.round(rhythm.meter))) : 4,
    beatConfidence: Number.isFinite(rhythm.confidence) ? Math.max(0, Math.min(1, rhythm.confidence)) : 0,
    beatsMs: series.beatsMs,
    downbeatsMs: sortedTimes(rhythm.downbeatsMs, durationMs),
    sections: deriveMusicSections({ durationMs, beatsMs: series.beatsMs, beatEnergy: series.beatEnergy }),
    tags,
    embedding,
  };
}


/** Decode once at the rhythm model's native sample rate, then reuse caller-owned PCM across both inference clients. */
export async function analyzeMusicAsset(asset: MediaAsset, options: AnalyzeMusicOptions = {}): Promise<MusicAnalysis> {
  if (asset.kind !== 'audio' && asset.kind !== 'video') throw new Error('Music analysis supports audio and video assets only');
  if (!asset.src) throw new Error('Music analysis requires a ready media source');
  throwIfAborted(options.signal);
  report(options, 'decode', 0);
  let samples: Float32Array | null = await decodeAudioSource(asset.src, DECODE_SAMPLE_RATE, options.signal);
  const durationMs = Math.round((samples.length / DECODE_SAMPLE_RATE) * 1000);
  if (!samples.length || !durationMs) throw new Error('Decoded media contains no audio samples');
  report(options, 'decode', 1);

  try {
    throwIfAborted(options.signal);
    report(options, 'rhythm', 0);
    const rhythm = await analyzeBeatThis(
      samples,
      DECODE_SAMPLE_RATE,
      (progress) => report(options, 'rhythm', progress),
      options.signal,
    );
    const series = beatSeries(rhythm.beatsMs, rhythm.beatEnergy, durationMs);
    report(options, 'rhythm', 1);

    throwIfAborted(options.signal);
    report(options, 'semantic', 0);
    const embedding = normalizeEmbedding(await embedMusicAudio(
      samples,
      DECODE_SAMPLE_RATE,
      (progress) => report(options, 'semantic', progress),
      options.signal,
    ));
    samples = null;
    const tags = normalizedTags(await tagsFromClapEmbedding(embedding));
    report(options, 'semantic', 1);
    return composeMusicAnalysis(asset, durationMs, rhythm, series, tags, embedding);
  } finally {
    samples = null;
  }
}
