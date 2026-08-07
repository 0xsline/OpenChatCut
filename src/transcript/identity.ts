import type { TranscriptCarrier, TranscriptWord } from './types.js';

let fallbackSequence = 0;

const randomId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  fallbackSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallbackSequence.toString(36)}`;
};

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const wordSeed = (word: TranscriptWord, index: number): string =>
  `${index}\u0000${word.start}\u0000${word.end}\u0000${word.text}\u0000${word.speaker ?? ''}`;

export interface TranscriptIdentityPatch {
  transcript: TranscriptWord[];
  transcriptGenerationId: string;
}

/** A new ASR result is a new generation even when text/timing happen to match an older result. */
export function newTranscriptGeneration(words: readonly TranscriptWord[]): TranscriptIdentityPatch {
  const transcriptGenerationId = randomId('tg');
  return {
    transcriptGenerationId,
    transcript: words.map((word) => ({ ...word, id: randomId('tw') })),
  };
}

/** Copy a persisted transcript without changing its generation or word identities. */
export function copyTranscriptIdentity(carrier: TranscriptCarrier): Partial<TranscriptCarrier> {
  if (!carrier.transcript?.length) return {};
  return {
    transcript: carrier.transcript.map((word) => ({ ...word })),
    transcriptGenerationId: carrier.transcriptGenerationId,
    transcriptStale: carrier.transcriptStale,
  };
}

/** Deterministically enrich an old persisted carrier; existing valid identities are never rewritten. */
export function backfillTranscriptIdentity<T extends TranscriptCarrier>(carrier: T, seed: string): T {
  if (!carrier.transcript?.length) return carrier;
  const transcriptGenerationId = validId(carrier.transcriptGenerationId)
    ? carrier.transcriptGenerationId
    : `tg4_${stableHash(seed)}`;
  const seen = new Set<string>();
  let changed = transcriptGenerationId !== carrier.transcriptGenerationId;
  const transcript = carrier.transcript.map((word, index) => {
    let id = validId(word.id) && !seen.has(word.id) ? word.id : '';
    if (!id) {
      id = `tw4_${stableHash(`${transcriptGenerationId}\u0000${wordSeed(word, index)}`)}`;
      while (seen.has(id)) id = `${id}_${index.toString(36)}`;
      changed = true;
    }
    seen.add(id);
    return id === word.id ? word : { ...word, id };
  });
  return changed ? { ...carrier, transcriptGenerationId, transcript } : carrier;
}

/** New manual cues carry a non-reusable identity; text/timing edits must retain it. */
export function newManualCueIdentity(): string {
  return randomId('mc');
}

/** Deterministically backfill imported/manual v4 cues without changing their content. */
export function backfillCueIdentities(words: readonly TranscriptWord[], seed: string): TranscriptWord[] {
  const seen = new Set<string>();
  let changed = false;
  const next = words.map((word, index) => {
    let id = validId(word.id) && !seen.has(word.id) ? word.id : '';
    if (!id) {
      id = `mc4_${stableHash(`${seed}\u0000${wordSeed(word, index)}`)}`;
      while (seen.has(id)) id = `${id}_${index.toString(36)}`;
      changed = true;
    }
    seen.add(id);
    return id === word.id ? word : { ...word, id };
  });
  return changed ? next : words as TranscriptWord[];
}

export function isStableIdentity(value: unknown): value is string {
  return validId(value);
}
