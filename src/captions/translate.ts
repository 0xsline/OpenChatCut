import type { TimelineItem } from '../editor/types';
import type { CaptionsData, TranslatedCue } from './types';
import { paginate } from './types';
import { resolveCaptionWords } from './resolve';
import { CAPTION_STYLE_BY_ID } from './styles';
import { generateAgentText } from '../agent/client';

// Translate the current caption phrases into `lang`, keeping each translation
// timed to its source phrase. Data model: a transcript translation VARIANT that
// shares the timeline (manage_transcript). Phrase-level (not word),
// since word order differs across languages; the variant reuses phrase timing.
export async function buildTranslation(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  lang: string,
): Promise<TranslatedCue[]> {
  const words = resolveCaptionWords(captions, items, fps);
  const pages = paginate(words, captions.pacing, CAPTION_STYLE_BY_ID[captions.template].wordsPerPage);
  const phrases = pages.map((p) => p.words.map((w) => w.text).join(' ').trim()).filter(Boolean);
  if (!phrases.length) return [];
  const translated = await translateLines(phrases, lang);
  return pages.map((p, i) => ({ start: p.start, end: p.end, text: translated[i] ?? '' }));
}

// Translate an ordered list of lines (phrases OR source words); returns the same
// count in the same order. Exported so the transcript translation VARIANT builder
// (src/agent/transcript-tools.ts) reuses the exact same LLM path — one line per
// source word in, one target string per word out (word-aligned in full context).
export async function translateLines(lines: string[], lang: string): Promise<string[]> {
  const phrases = lines;
  const numbered = phrases.map((p, i) => `${i + 1}. ${p}`).join('\n');
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
