import type { TranscriptWord } from './types';

export interface TranscriptPhrase {
  sourceItemId: string;
  /** Source-media timestamp in milliseconds. */
  start: number;
  /** Source-media timestamp in milliseconds. */
  end: number;
  speaker: string | null;
  text: string;
  /** Source-media silence immediately before this phrase, in milliseconds. */
  silenceBefore: number;
  wordCount: number;
  /** Half-open ranges into the original word array. Usually a single range. */
  wordRanges: Array<[start: number, endExclusive: number]>;
}

export interface PackTranscriptOptions {
  sourceItemId: string;
  silenceThresholdMs?: number;
  maxWordsPerPhrase?: number;
  /** Optional playback-order subset of indices into `words`. */
  wordIndices?: number[];
}

interface IndexedTranscriptWord {
  word: TranscriptWord;
  index: number;
}

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;
const NO_SPACE_BEFORE = ',.;:!?%)]}，。！？；：、…';
const NO_SPACE_AFTER = '([{“‘';
const CONTRACTION = /^(?:['’](?:s|d|m|re|ve|ll)|n't)$/iu;

/** Join ASR tokens without introducing spaces around CJK or punctuation. */
export function joinTranscriptWords(words: readonly Pick<TranscriptWord, 'text'>[]): string {
  let output = '';
  for (const word of words) {
    const token = word.text.trim();
    if (!token) continue;
    if (!output) {
      output = token;
      continue;
    }
    const previous = output.at(-1) ?? '';
    const first = token[0] ?? '';
    const attach = NO_SPACE_BEFORE.includes(first)
      || NO_SPACE_AFTER.includes(previous)
      || CONTRACTION.test(token)
      || CJK.test(previous)
      || CJK.test(first);
    output += attach ? token : ` ${token}`;
  }
  return output;
}

function compactRanges(indices: number[]): Array<[number, number]> {
  if (!indices.length) return [];
  const ranges: Array<[number, number]> = [];
  let start = indices[0]!;
  let previous = start;
  for (let position = 1; position < indices.length; position += 1) {
    const current = indices[position]!;
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push([start, previous + 1]);
    start = current;
    previous = current;
  }
  ranges.push([start, previous + 1]);
  return ranges;
}

/**
 * Build a compact, derived phrase view. The source word array remains the sole
 * transcript record; wordRanges make every phrase traceable back to it.
 */
export function packTranscriptPhrases(
  words: readonly TranscriptWord[],
  options: PackTranscriptOptions,
): TranscriptPhrase[] {
  const silenceThresholdMs = Math.max(0, options.silenceThresholdMs ?? 500);
  const maxWordsPerPhrase = Math.max(1, Math.round(options.maxWordsPerPhrase ?? 40));
  const order = options.wordIndices ?? words.map((_, index) => index);
  const seen = new Set<number>();
  const view: IndexedTranscriptWord[] = [];
  for (const index of order) {
    if (!Number.isInteger(index) || index < 0 || index >= words.length || seen.has(index)) continue;
    seen.add(index);
    view.push({ word: words[index]!, index });
  }
  if (!view.length) return [];

  const phrases: TranscriptPhrase[] = [];
  let current: IndexedTranscriptWord[] = [];
  let silenceBefore = Math.max(0, view[0]!.word.start);

  const flush = () => {
    if (!current.length) return;
    const first = current[0]!.word;
    const last = current[current.length - 1]!.word;
    phrases.push({
      sourceItemId: options.sourceItemId,
      start: first.start,
      end: last.end,
      speaker: first.speaker ?? null,
      text: joinTranscriptWords(current.map(({ word }) => word)),
      silenceBefore,
      wordCount: current.length,
      wordRanges: compactRanges(current.map(({ index }) => index)),
    });
    current = [];
  };

  for (const entry of view) {
    if (!current.length) {
      current = [entry];
      continue;
    }
    const previous = current[current.length - 1]!.word;
    const gap = entry.word.start - previous.end;
    const speakerChanged = (entry.word.speaker ?? null) !== (current[0]!.word.speaker ?? null);
    const split = gap < 0
      || gap >= silenceThresholdMs
      || speakerChanged
      || current.length >= maxWordsPerPhrase;
    if (split) {
      flush();
      silenceBefore = Math.max(0, gap);
    }
    current.push(entry);
  }
  flush();
  return phrases;
}
