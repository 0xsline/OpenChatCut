import type { TimelineItem } from '../editor/types';
import type { CaptionsData, TranslatedCue } from './types';
import { CAPTION_MAX_CHARS_PER_LINE, CAPTION_MAX_VISUAL_LINES, paginate } from './types';
import { resolveCaptionWords } from './resolve';
import { captionStyleFor } from './styles';

// Translate the current caption phrases into `lang`, keeping each translation
// timed to its source phrase. Data model: a transcript translation VARIANT that
// shares the timeline (manage_transcript). Phrase-level (not word),
// since word order differs across languages; the variant reuses phrase timing.
/**
 * Compact digest of the timing the translation cues are pinned to. Cues store
 * absolute timeline ms; when the source is re-timed (words deleted, silence
 * compressed, clip moved) the digest changes and the translation is stale.
 */
export function captionTimingFingerprint(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
): string {
  const words = resolveCaptionWords(captions, items, fps);
  if (!words.length) return 'empty';
  let hash = 0;
  for (const word of words) {
    // Rounded to whole ms: sub-millisecond float noise must not read as an edit.
    hash = (Math.imul(hash, 31) + Math.round(word.start)) | 0;
    hash = (Math.imul(hash, 31) + Math.round(word.end)) | 0;
  }
  return `${words.length}:${Math.round(words[0]!.start)}:${Math.round(words[words.length - 1]!.end)}:${(hash >>> 0).toString(36)}`;
}

/** Whether stored translation cues no longer match the current caption timing.
 * Unknown (older data with no fingerprint) is NOT stale — never nag about a
 * translation this build cannot prove is out of date. */
export function isTranslationStale(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
): boolean {
  if (!captions.translation?.length || !captions.translationFingerprint) return false;
  return captions.translationFingerprint !== captionTimingFingerprint(captions, items, fps);
}

export interface BuiltTranslation {
  readonly cues: TranslatedCue[];
  readonly fingerprint: string;
}

export async function buildTranslation(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  lang: string,
): Promise<BuiltTranslation> {
  const words = resolveCaptionWords(captions, items, fps);
  const pages = paginate(
    words,
    captions.pacing,
    captionStyleFor(captions.template).wordsPerPage,
    undefined,
    CAPTION_MAX_CHARS_PER_LINE,
    CAPTION_MAX_VISUAL_LINES,
  );
  const phrases = pages.map((p) => p.words.map((w) => w.text).join(' ').trim()).filter(Boolean);
  const fingerprint = captionTimingFingerprint(captions, items, fps);
  if (!phrases.length) return { cues: [], fingerprint };
  const translated = await translateLines(phrases, lang);
  return {
    cues: pages.map((p, i) => ({ start: p.start, end: p.end, text: translated[i] ?? '' })),
    fingerprint,
  };
}

// Translate an ordered list of lines (phrases OR source words); returns the same
// count in the same order. Exported so the transcript translation VARIANT builder
// (src/agent/transcript-tools.ts) reuses the exact same LLM path — one line per
// source word in, one target string per word out (word-aligned in full context).
export async function translateLines(lines: string[], lang: string): Promise<string[]> {
  const phrases = lines;
  const numbered = phrases.map((p, i) => `${i + 1}. ${p}`).join('\n');
  // Translation is an explicit send boundary; do not load the AI client at editor startup.
  const { generateAgentText } = await import('../agent/client');
  const text = (await generateAgentText({
    maxOutputTokens: 8000,
    system: `You are a subtitle translator. Translate each numbered line into ${lang}. Keep it natural and concise (subtitle length). Return ONLY a JSON array of strings — one per input line, same order and same count, no numbering, no extra prose.`,
    prompt: numbered,
  })).trim();
  const clean = text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  let arr: unknown;
  try {
    arr = JSON.parse(clean);
  } catch {
    // fall back to line-splitting if the model didn't return clean JSON
    arr = clean.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  }
  if (!Array.isArray(arr)) throw new Error('translation did not return a list');
  // pad/truncate to keep 1:1 alignment with the source phrases
  return phrases.map((_, i) => String(arr[i] ?? ''));
}
