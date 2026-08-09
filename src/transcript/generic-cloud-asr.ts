import { loadTranscriptionSource, transcriptionSourceForPath, TranscriptionError } from './assemblyai';
import type {
  AssemblyAiCheckpointWriter,
  TranscribeOptions,
} from './assemblyai';
import type {
  TranscriptResult,
  TranscriptUtterance,
  TranscriptWord,
  TranscriptionProviderId,
} from './types';

export type GenericCloudTranscriptionProvider = Exclude<
  TranscriptionProviderId,
  'assemblyai' | 'local'
>;

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

function parseTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`transcription response has invalid ${label}`);
  }
  return value;
}

function parseWord(value: unknown): TranscriptWord {
  const word = asRecord(value);
  if (!word || typeof word.text !== 'string') {
    throw new Error('transcription response has an invalid word');
  }
  const start = parseTimestamp(word.start, 'word start');
  const end = parseTimestamp(word.end, 'word end');
  if (end < start) throw new Error('transcription response has a reversed word timestamp');
  if (word.id !== undefined && typeof word.id !== 'string') {
    throw new Error('transcription response has an invalid word id');
  }
  if (word.speaker !== undefined && word.speaker !== null && typeof word.speaker !== 'string') {
    throw new Error('transcription response has an invalid word speaker');
  }
  return {
    ...(word.id === undefined ? {} : { id: word.id }),
    text: word.text,
    start,
    end,
    ...(word.speaker === undefined ? {} : { speaker: word.speaker }),
  };
}

function parseUtterance(value: unknown): TranscriptUtterance {
  const utterance = asRecord(value);
  if (!utterance || typeof utterance.speaker !== 'string' || typeof utterance.text !== 'string') {
    throw new Error('transcription response has an invalid utterance');
  }
  const start = parseTimestamp(utterance.start, 'utterance start');
  const end = parseTimestamp(utterance.end, 'utterance end');
  if (end < start || !Array.isArray(utterance.words)) {
    throw new Error('transcription response has an invalid utterance range');
  }
  return {
    speaker: utterance.speaker,
    text: utterance.text,
    start,
    end,
    words: utterance.words.map(parseWord),
  };
}

export function parseTranscriptResult(value: unknown): TranscriptResult {
  const result = asRecord(value);
  if (!result || typeof result.text !== 'string' || !Array.isArray(result.words)
    || !Array.isArray(result.utterances)) {
    throw new Error('transcription service returned an invalid response');
  }
  return {
    text: result.text,
    words: result.words.map(parseWord),
    utterances: result.utterances.map(parseUtterance),
  };
}

async function loadGenericCloudSource(path: string, opts: TranscribeOptions): Promise<Blob> {
  const source = await transcriptionSourceForPath(path, opts);
  try {
    return await loadTranscriptionSource(source);
  } catch (error) {
    if (source === path || !(error instanceof TranscriptionError)
      || error.code !== 'source-unavailable') throw error;
    return loadTranscriptionSource(path);
  }
}

async function postTranscription(
  provider: GenericCloudTranscriptionProvider,
  blob: Blob,
  languageCode: string,
  diarize: boolean,
): Promise<TranscriptResult> {
  const query = new URLSearchParams({
    provider,
    language: languageCode,
    diarize: diarize ? '1' : '0',
  });
  let response: Response;
  try {
    response = await fetch(`/api/transcribe?${query}`, { method: 'POST', body: blob });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TranscriptionError('service-unavailable', detail);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`transcription failed: HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  try {
    return parseTranscriptResult(JSON.parse(body) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('transcription service returned invalid JSON');
    throw error;
  }
}

export async function genericCloudTranscribePath(
  provider: GenericCloudTranscriptionProvider,
  path: string,
  onCheckpoint: AssemblyAiCheckpointWriter,
  onWait?: (note?: string) => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  await onCheckpoint({ providerStatus: 'processing' });
  onWait?.();
  const blob = await loadGenericCloudSource(path, opts);
  const result = await postTranscription(
    provider,
    blob,
    opts.languageCode ?? 'zh',
    opts.diarize ?? true,
  );
  await onCheckpoint({ providerStatus: 'completed' });
  return result;
}
