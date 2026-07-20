// Pure helpers for multi-language transcript variants (translations / corrections).
//
// 词帧一致性约束:一个变体只承载 TEXT。词的 start/end/speaker(帧位)
// 永远取自 source。`resolveVariantText` 是唯一把变体套回源词的入口,它只替换 .text,
// 绝不动 timing——所以翻译永远不会重排或移动某个词。未设变体 = 原样返回源词(字节等同)。

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
    // 只换 text，start/end/speaker 原样；缺项则原样返回该源词(引用不变)。
    return text === undefined ? w : { ...w, text };
  });
}

/** Default display label for a variant when none is supplied. */
function defaultLabel(lang: string, kind: TranscriptVariant['kind']): string {
  return kind === 'translation' ? lang : `${lang}(校正)`;
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
