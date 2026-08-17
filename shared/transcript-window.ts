// Desktop transcript window: main-window → floating-window payload and
// IPC channels. Payload is plain JSON (structured clone), validated at the
// main-process boundary like every other renderer-provided input.
export interface TranscriptWindowEntry {
  id: string;
  name: string;
  transcript: Array<{ text: string; start: number; end: number }>;
}

export interface TranscriptWindowPayload {
  entries: TranscriptWindowEntry[];
  /** Index of the initially viewed entry (clamped by the consumer). */
  index: number;
}

export const TRANSCRIPT_WINDOW_CHANNELS = {
  open: 'openchatcut:open-transcript-window',
  update: 'openchatcut:transcript-window-update',
} as const;

const MAX_ENTRIES = 200;
const MAX_WORDS_PER_ENTRY = 50_000;

function isWord(value: unknown): value is TranscriptWindowEntry['transcript'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const word = value as Record<string, unknown>;
  return typeof word.text === 'string'
    && typeof word.start === 'number' && Number.isFinite(word.start)
    && typeof word.end === 'number' && Number.isFinite(word.end);
}

export function isTranscriptWindowPayload(value: unknown): value is TranscriptWindowPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.entries) || payload.entries.length > MAX_ENTRIES) return false;
  if (typeof payload.index !== 'number' || !Number.isInteger(payload.index) || payload.index < 0) return false;
  return payload.entries.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    return typeof record.id === 'string'
      && record.id.length > 0
      && typeof record.name === 'string'
      && Array.isArray(record.transcript)
      && record.transcript.length <= MAX_WORDS_PER_ENTRY
      && record.transcript.every(isWord);
  });
}
