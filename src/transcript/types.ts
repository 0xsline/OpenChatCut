// Word-level transcript (AssemblyAI shape, timestamps in milliseconds).

export interface TranscriptWord {
  text: string;
  start: number; // ms
  end: number; // ms
  speaker?: string | null; // 'A' | 'B' | ... when diarization is on
}

/** One speaker turn (AssemblyAI utterance) = a "片段" in segment view. */
export interface TranscriptUtterance {
  speaker: string;
  text: string;
  start: number; // ms
  end: number; // ms
  words: TranscriptWord[];
}

export interface TranscriptResult {
  text: string;
  words: TranscriptWord[];
  utterances: TranscriptUtterance[];
}

/** One text-only entry of a transcript variant, keyed by the SOURCE word index. */
export interface TranscriptVariantWord {
  /** index into the source `TranscriptWord[]` this text replaces */
  i: number;
  text: string;
}

/**
 * A text-only variant of a transcript — a translation into another language or a
 * corrected pass. Words are keyed by their SOURCE word index `i` and carry ONLY
 * text: start/end/speaker ALWAYS come from the source word, so a variant never
 * moves a word on the timeline, preserving word/frame alignment. A source-word index with no
 * entry shows the source text (variants are sparse overlays, not full copies).
 */
export interface TranscriptVariant {
  id: string;
  /** display language / label of this variant, e.g. "English", "中文" */
  lang: string;
  kind: 'translation' | 'corrected';
  label: string;
  words: TranscriptVariantWord[];
}

export type TranscriptStatus = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

/** ms → frame at the given fps. */
export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}
