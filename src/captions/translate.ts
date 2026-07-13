import type Anthropic from '@anthropic-ai/sdk';
import type { TimelineItem } from '../editor/types';
import type { CaptionsData, TranslatedCue } from './types';
import { paginate } from './types';
import { resolveCaptionWords } from './resolve';
import { anthropic, MODEL } from '../agent/client';

// Translate the current caption phrases into `lang`, keeping each translation
// timed to its source phrase. Source model: a transcript translation VARIANT that
// shares the timeline (复刻规格 §7 manage_transcript). Phrase-level (not word),
// since word order differs across languages; the variant reuses phrase timing.
export async function buildTranslation(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  lang: string,
): Promise<TranslatedCue[]> {
  const words = resolveCaptionWords(captions, items, fps);
  const pages = paginate(words, captions.pacing);
  const phrases = pages.map((p) => p.words.map((w) => w.text).join(' ').trim()).filter(Boolean);
  if (!phrases.length) return [];
  const translated = await translatePhrases(phrases, lang);
  return pages.map((p, i) => ({ start: p.start, end: p.end, text: translated[i] ?? '' }));
}

// Translate an ordered list of phrases; returns the same count, same order.
async function translatePhrases(phrases: string[], lang: string): Promise<string[]> {
  const numbered = phrases.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: `You are a subtitle translator. Translate each numbered line into ${lang}. Keep it natural and concise (subtitle length). Return ONLY a JSON array of strings — one per input line, same order and same count, no numbering, no extra prose.`,
    messages: [{ role: 'user', content: numbered }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
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
