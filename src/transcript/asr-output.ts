// Last-line defence against degenerate Whisper output.
//
// Whisper is a language model, so a non-speech clip does not produce nothing:
// it produces fluent, confident text. Measured on this project's own fixtures:
// a 5 s 440 Hz tone through the browser engine (transformers.js whisper-small)
// returned ONE 445-character chunk of "!!!!…" with timestamp [-0.02, 0], which
// the caption builder then persisted as a single cue. whisper.cpp produced
// "(Bell)" / "(字幕製作:貝爾)". Silero VAD is the speech evidence that keeps
// both engines from running on that audio (local-asr.ts for the browser engine,
// whisper.cpp's own --vad for the desktop engine); this filter is the extra
// guard for degenerate output that still slips through, because a chunk that is
// one character or a short run repeated dozens of times is never speech.
//
// Pure and dependency-free so the ASR client and its checks can share it.

/** Shorter runs are plausible speech ("!!!", "hahaha") and are left alone. */
const MIN_DEGENERATE_LENGTH = 24;
/** Longest repeating unit considered ("Beeeeee…" is period 2, "abab…" period 2-4). */
const MAX_REPEATING_UNIT = 8;
/** A unit must repeat at least this many times to count as degenerate. */
const MIN_REPEATS = 4;

/**
 * Whether `text` is a degenerate repetition rather than words: every character
 * is one of at most two distinct code points, or the whole string is a unit of
 * at most {@link MAX_REPEATING_UNIT} characters repeating to the end.
 */
export function isDegenerateAsrText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_DEGENERATE_LENGTH) return false;
  const distinct = new Set(trimmed);
  if (distinct.size <= 2) return true;
  for (let unit = 2; unit <= MAX_REPEATING_UNIT; unit += 1) {
    if (trimmed.length < unit * MIN_REPEATS) continue;
    let repeats = true;
    for (let index = unit; index < trimmed.length; index += 1) {
      if (trimmed[index] !== trimmed[index % unit]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

/**
 * Remove degenerate chunks from a segment list, and remove the same substrings
 * from the joined `text` so the caption source never carries the hallucination.
 * `dropped` reports whether anything was removed.
 */
export function stripDegenerateSegments<T extends { readonly text: string }>(
  segments: readonly T[],
  text: string,
): { segments: readonly T[]; text: string; dropped: boolean } {
  const kept = segments.filter((segment) => !isDegenerateAsrText(segment.text));
  if (kept.length === segments.length) return { segments, text, dropped: false };
  let cleaned = text;
  for (const segment of segments) {
    if (isDegenerateAsrText(segment.text)) cleaned = cleaned.replace(segment.text, '');
  }
  return { segments: kept, text: cleaned.trim(), dropped: true };
}
