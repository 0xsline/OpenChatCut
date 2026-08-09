export const MUSIC_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const MUSIC_MODEL_PACK_FINGERPRINTS = Object.freeze({
  rhythm: 'rhythm-lite@4e971bd43753023e1bf961c34a0cb74985cfcb88',
  semantic: 'music-semantics-lite@c28f2883575e590e04d3146ff0713c2448d691ba',
});

export const MUSIC_ANALYZER_FINGERPRINT = [
  `schema-${MUSIC_ANALYSIS_SCHEMA_VERSION}`,
  'music-analysis-v1',
  MUSIC_MODEL_PACK_FINGERPRINTS.rhythm,
  MUSIC_MODEL_PACK_FINGERPRINTS.semantic,
  'energy-change-v1',
  'clap-profile-v1',
].join('|');


export type MusicTagKind = 'genre' | 'mood' | 'instrument' | 'usage';

export interface MusicTag {
  kind: MusicTagKind;
  label: string;
  score: number;
}

export type MusicSectionRole =
  | 'intro-like'
  | 'build'
  | 'peak'
  | 'break'
  | 'steady'
  | 'outro-like';

export interface MusicSection {
  fromMs: number;
  toMs: number;
  role: MusicSectionRole;
  energy: number;
  boundaryConfidence: number;
}

export interface BeatThisAnalysis {
  readonly bpm: number;
  readonly meter: number;
  readonly confidence: number;
  readonly beatsMs: number[];
  readonly downbeatsMs: number[];
  /** Per-beat local RMS energy, robustly normalized to 0–1 and aligned with beatsMs. */
  readonly beatEnergy: number[];
}

export interface MusicAnalysis {
  schemaVersion: typeof MUSIC_ANALYSIS_SCHEMA_VERSION;
  assetId: string;
  sourceRevision: string;
  createdAt: number;
  durationMs: number;
  modelPacks: {
    rhythm: string;
    semantic: string;
  };
  bpm: number;
  meter: number;
  beatConfidence: number;
  beatsMs: number[];
  downbeatsMs: number[];
  sections: MusicSection[];
  tags: MusicTag[];
  /** Normalized CLAP audio embedding. Derived cache only; never written to ProjectDoc. */
  embedding: number[];
}

export type MusicAnalysisStatus =
  | { state: 'idle' }
  | { state: 'queued' }
  | { state: 'running'; phase: 'decode' | 'rhythm' | 'semantic'; progress: number }
  | { state: 'ready'; analysis: MusicAnalysis }
  | { state: 'error'; message: string };

export interface MusicEditPlan {
  schemaVersion: 1;
  analysisRef: string;
  musicItemId: string;
  targetItemIds: string[];
  timing: 'beat' | 'downbeat' | 'section';
  range: { fromFrame: number; toFrame: number };
  cutFrames: number[];
}
