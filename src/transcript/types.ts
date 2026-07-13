// Word-level transcript (AssemblyAI shape, timestamps in milliseconds).

export interface TranscriptWord {
  text: string;
  start: number; // ms
  end: number; // ms
}

export interface TranscriptResult {
  text: string;
  words: TranscriptWord[];
}

export type TranscriptStatus = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

/** ms → frame at the given fps. */
export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}
