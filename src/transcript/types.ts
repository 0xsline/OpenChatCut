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

export type TranscriptStatus = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

/** ms → frame at the given fps. */
export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}
