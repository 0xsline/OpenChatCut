// Pure helpers for multi-language transcript variants (translations / corrections).
//
// Word frame consistency constraint: A variant only carries TEXT. Word start/end/speaker (frame bit)
// Always taken from source. `resolveVariantText` is the only entry to put the variant back into the source word, it only replaces .text,
// Never move timing - so the translation never rearranges or moves a word. No variant set = return the source word unchanged (byte equivalent).

import type { TranscriptWord, TranscriptVariant, TranscriptVariantWord } from './types';

/** Overlay a variant's text onto the source words. Every returned word keeps the
 * source word's start/end/speaker EXACTLY; only `.text` is swapped where the
 * variant has an entry for that index. No entries → the SAME array reference back
 * (byte-identical no-op). Out-of-range indices in the variant are ignored (we key
 * off source indices), so a malformed variant can never touch a word that isn't
 * there. This is the single place a variant ever meets the timeline. */
export function resolveVariantText(sourceWords: TranscriptWord[], variant: TranscriptVariant): TranscriptWord[] {
  if (!variant.words.length) return sourceWords;
  const byIndex = new Map(variant.words.map((w) => [w.i, w.text] as const));
  if (!byIndex.size) return sourceWords;
  return sourceWords.map((w, i) => {
    const text = byIndex.get(i);
    // Only replace text, and leave start/end/speaker as they are; if there are missing items, the source word will be returned as is (the reference remains unchanged).
    return text === undefined ? w : { ...w, text };
  });
}

/** Default display label for a variant when none is supplied. */
function defaultLabel(lang: string, kind: TranscriptVariant['kind']): string {
  return kind === 'translation' ? lang : `${lang}(Correction)`;
}

/** Build a variant. Validates at the boundary (LLM/user text is untrusted): lang
 * must be non-empty; word entries with a bad index or non-string text are dropped. */
export function createVariant(opts: {
  lang: string;
  kind: TranscriptVariant['kind'];
  words: TranscriptVariantWord[];
  label?: string;
  id?: string;
}): TranscriptVariant {
  const lang = opts.lang.trim();
  if (!lang) throw new Error('variant lang is required');
  const words = opts.words.filter((w) => Number.isInteger(w.i) && w.i >= 0 && typeof w.text === 'string');
  return {
    id: opts.id ?? `var_${crypto.randomUUID()}`,
    lang,
    kind: opts.kind,
    label: opts.label?.trim() || defaultLabel(lang, opts.kind),
    words,
  };
}

/** First variant matching a language (and optionally a kind). Used to decide
 * reuse-vs-create (ensure semantics) and to resolve a caption's chosen variant. */
export function findVariantByLang(
  variants: TranscriptVariant[] | undefined,
  lang: string,
  kind?: TranscriptVariant['kind'],
): TranscriptVariant | undefined {
  const l = lang.trim();
  return (variants ?? []).find((v) => v.lang === l && (!kind || v.kind === kind));
}

/** Immutably add or replace a variant (by id) in a list. */
export function upsertVariant(variants: TranscriptVariant[] | undefined, variant: TranscriptVariant): TranscriptVariant[] {
  const base = variants ?? [];
  const idx = base.findIndex((v) => v.id === variant.id);
  return idx < 0 ? [...base, variant] : base.map((v, i) => (i === idx ? variant : v));
}
