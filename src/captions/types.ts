import type { TranscriptWord } from '../transcript/types';
import type { CaptionStyleOverride } from './styles';
import { segmentWords } from './segmenter';

/** 3×3 title-safe anchors + shorthands (source edit_captions action=layout preset). */
export type CaptionAnchor =
  | 'top' | 'center' | 'bottom'
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** Whole-caption-block placement (source edit_captions action=layout). Anchor picks
 * the title-safe grid cell; offset*Ratio nudges it as a fraction of canvas w/h. */
export interface CaptionLayout {
  anchor?: CaptionAnchor;
  offsetXRatio?: number;
  offsetYRatio?: number;
}

// Captions (字幕) = a styled singleton overlay burned onto the video, separate
// from the 文字稿 editing surface. Words are paginated into "pages" and shown in
// sync with playback (timings are TIMELINE ms once resolved).
//
// Source-faithful: captions mirror an audio item's transcript. When that item is
// edited (words deleted / silence compressed) the caption words are re-projected
// onto the edited timeline (see retimeWords) — captions follow edits. If no item
// is referenced, `words` + `offsetFrames` provide a standalone (sample) source.
export type CaptionTemplate = 'plain' | 'persona' | 'off-the-wall' | 'the-french-dispatch' | 'dogme' | 'boyz-n-the-hood' | 'bubble-pop' | 'submagic' | 'story' | 'bili' | 'luxe' | 'noir' | 'atelier' | 'product' | 'signal' | 'studio' | 'white-card' | 'bold-outline' | 'deyi-card' | 'tiktok' | 'netflix';
export type CaptionPacing = 'word' | 'phrase';

/** One translated caption phrase, timed on the (edited) timeline in ms. */
export interface TranslatedCue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionsData {
  enabled: boolean;
  template: CaptionTemplate;
  pacing: CaptionPacing;
  /** audio item whose (edited) transcript drives the captions */
  sourceItemId?: string | null;
  /** MULTI-source merge (新增,自定字段名 — 逆向 `复刻规格-Agent工具与后端.md` 的
   * edit_captions 条目只提"源路由",未见 source_set/source_add/sourceScope 等动作名,
   * 按"字幕可汇总全部已转写轨"的产品意图自定): item ids whose (edited) transcripts
   * merge into ONE time-ordered caption stream (see resolveCaptionWords in resolve.ts).
   * Empty/undefined → no effect, `sourceItemId` still drives (backward compatible). */
  sources?: string[];
  /** 'timeline' = ignore `sources`/`sourceItemId`, merge EVERY item with a transcript;
   * 'item' or undefined (default) = single-source `sourceItemId`, or `sources` if set. */
  sourceMode?: 'item' | 'timeline';
  /** standalone fallback source words (source ms) when no item is referenced */
  words?: TranscriptWord[];
  /** timeline offset (frames) for the standalone words */
  offsetFrames?: number;
  /** bilingual: show a translated second line under the original */
  bilingual?: boolean;
  /** translation language label (e.g. "中文") — display/regeneration hint */
  translationLang?: string;
  /** translated phrase cues (timeline ms), aligned to the source phrases */
  translation?: TranslatedCue[];
  /** display a transcript VARIANT (translation / corrected pass) as the caption
   * text instead of the source words. Keys `sourceItemId`'s `variants` by id; the
   * variant only swaps each word's TEXT — timing stays the source's (护城河③). Only
   * applies on the single-source path (`sourceItemId`); the multi-source merge
   * ignores it (no single transcript to key a variant off). Unset = show source. */
  captionVariantId?: string;
  /** per-word DISPLAY overrides for the captions overlay (hide / retext / force
   * a page break), WITHOUT touching the transcript or its timing. Keyed by the
   * word's index in the source track transcript (or in the standalone `words`
   * fallback) — see `read_captions`/`edit_caption_words` in src/agent. When
   * MULTIPLE sources are merged (`sources`/`sourceMode:'timeline'`), the index
   * space instead keys off the word's POSITION in the merged output (0..N-1) —
   * see resolveCaptionWordIndices in resolve.ts. */
  wordOverrides?: Record<number, CaptionWordOverride>;
  /** custom style fields layered OVER the template preset (source edit_captions
   * action=style). Only what the user set; unset fields inherit the preset. */
  styleOverride?: CaptionStyleOverride;
  /** whole-block placement (source edit_captions action=layout). Unset = the
   * template's default bottom-center. */
  layout?: CaptionLayout;
}

export interface CaptionWordOverride {
  hidden?: boolean;
  text?: string;
  forceBreak?: boolean;
}

export interface CaptionPage {
  words: TranscriptWord[];
  start: number; // ms
  end: number; // ms
}

const SENTENCE_END = /[.!?。！?…,,]$/;
const MAX_PHRASE_WORDS = 6;
const GAP_MS = 700;
const LINGER_MS = 1500;

// Group words into display pages: one word each (word pacing), or short phrases
// broken on punctuation / length / a big pause (phrase pacing). `breakBefore`
// (positions into `words`) forces a page to start right there — used by
// wordOverrides' forceBreak (src/captions/resolve.ts). Optional + defaults to
// none, so existing callers (translate.ts, no-override render) stay unaffected.
// `maxCharsPerLine` (optional) switches phrase pacing to the content-aware
// segmenter (segmenter.ts, 源站断点打分语义); unset → 旧逻辑逐字节不变。
export function paginate(words: TranscriptWord[], pacing: CaptionPacing, maxPhraseWords = MAX_PHRASE_WORDS, breakBefore?: Set<number>, maxCharsPerLine?: number): CaptionPage[] {
  if (pacing === 'word') return words.map((w) => ({ words: [w], start: w.start, end: w.end }));
  if (maxCharsPerLine !== undefined) return paginateContentAware(words, maxPhraseWords, breakBefore, maxCharsPerLine);
  const pages: CaptionPage[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (cur.length) pages.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    if (breakBefore?.has(i) && cur.length) flush(); // forceBreak: 在该词前另起一页
    cur.push(words[i]);
    const next = words[i + 1];
    const bigGap = next ? next.start - words[i].end > GAP_MS : false;
    if (cur.length >= maxPhraseWords || SENTENCE_END.test(words[i].text) || bigGap) flush();
  }
  flush();
  return pages;
}

// 内容感知分页(P1-#3):forceBreak 仍最高优先——先按 breakBefore 切成硬块,再在
// 每块内跑源站语义的 segmentWords(标点/句末/CJK 助词/孤词打分回退断行)。仅当
// 调用方显式给 maxCharsPerLine 才走这里;21 个预设默认不传,行为不变(逐预设启用留后续)。
function paginateContentAware(words: TranscriptWord[], maxPhraseWords: number, breakBefore: Set<number> | undefined, maxCharsPerLine: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  const cuts = [...(breakBefore ?? [])].filter((i) => i > 0 && i < words.length).sort((a, b) => a - b);
  let chunkStart = 0;
  for (const boundary of [...cuts, words.length]) {
    const chunk = words.slice(chunkStart, boundary);
    const starts = segmentWords(chunk, { maxCharsPerLine, wordsPerPage: maxPhraseWords });
    for (let s = 0; s < starts.length; s++) {
      const ws = chunk.slice(starts[s], starts[s + 1] ?? chunk.length);
      if (ws.length) pages.push({ words: ws, start: ws[0].start, end: ws[ws.length - 1].end });
    }
    chunkStart = boundary;
  }
  return pages;
}

// The page to show at time `ms`: the latest page whose start has passed, held
// until the next page starts (or LINGER_MS after the last page's end).
export function activePage(pages: CaptionPage[], ms: number): CaptionPage | null {
  for (let i = pages.length - 1; i >= 0; i--) {
    if (ms >= pages[i].start) {
      const until = pages[i + 1]?.start ?? pages[i].end + LINGER_MS;
      return ms < until ? pages[i] : null;
    }
  }
  return null;
}

// Index of the word currently being spoken within a page (for karaoke highlight).
export function currentWordIndex(page: CaptionPage, ms: number): number {
  let idx = 0;
  for (let i = 0; i < page.words.length; i++) if (ms >= page.words[i].start) idx = i;
  return idx;
}

// The translated cue active at time `ms` (held until the next cue starts).
export function activeTranslation(cues: TranslatedCue[], ms: number): TranslatedCue | null {
  for (let i = cues.length - 1; i >= 0; i--) {
    if (ms >= cues[i].start) {
      const until = cues[i + 1]?.start ?? cues[i].end + LINGER_MS;
      return ms < until ? cues[i] : null;
    }
  }
  return null;
}
