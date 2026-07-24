import type { TranscriptWord } from '../transcript/types';
import type { CaptionStyleOverride } from './styles';
import { segmentWords } from './segmenter';

/** 3×3 title-safe anchors + shorthands (edit_captions action=layout preset). */
export type CaptionAnchor =
  | 'top' | 'center' | 'bottom'
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** Whole-caption-block placement (edit_captions action=layout). Anchor picks
 * the title-safe grid cell; offset*Ratio nudges it as a fraction of canvas w/h. */
export interface CaptionLayout {
  anchor?: CaptionAnchor;
  offsetXRatio?: number;
  offsetYRatio?: number;
}

// Captions = a styled singleton overlay burned onto the video, separate
// from the manuscript editing surface. Words are paginated into "pages" and shown in
// sync with playback (timings are TIMELINE ms once resolved).
//
// Captions mirror an audio item's transcript. When that item is
// edited (words deleted / silence compressed) the caption words are re-projected
// onto the edited timeline (see retimeWords) — captions follow edits. If no item
// is referenced, `words` + `offsetFrames` provide a standalone (sample) source.
export type CaptionTemplate = 'plain' | 'black-bar' | 'persona' | 'off-the-wall' | 'the-french-dispatch' | 'dogme' | 'boyz-n-the-hood' | 'bubble-pop' | 'submagic' | 'story' | 'bili' | 'luxe' | 'noir' | 'atelier' | 'product' | 'signal' | 'studio' | 'white-card' | 'bold-outline' | 'deyi-card' | 'tiktok' | 'netflix';
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
  /** MULTI-source merge — Subtitles can be compiled into all transcribed tracks: item ids whose (edited) transcripts
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
  /** translation language label (e.g. "Chinese") — display/regeneration hint */
  translationLang?: string;
  /** translated phrase cues (timeline ms), aligned to the source phrases */
  translation?: TranslatedCue[];
  /** display a transcript VARIANT (translation / corrected pass) as the caption
   * text instead of the source words. Keys `sourceItemId`'s `variants` by id; the
   * variant only swaps each word's TEXT; timing stays with the source word. Only
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
  /** custom style fields layered OVER the template preset (edit_captions
   * action=style). Only what the user set; unset fields inherit the preset. */
  styleOverride?: CaptionStyleOverride;
  /** whole-block placement (edit_captions action=layout). Unset = the
   * template's default bottom-center. */
  layout?: CaptionLayout;
  /** multiple lanes source list(sourceScope.sources). Rendering multi-lane engine when present;
   * with the old `sources`(Single stream merge)mutually exclusive,Old fields should be cleared when writing. */
  sourceEntries?: CaptionSourceEntry[];
  /** Much source Screen allocation strategy(action=layout_policy);null/Not set → auto-stack。 */
  layoutPolicy?: CaptionLayoutPolicy | null;
  /** per-source Render overlay,key = sourceEntries[].id(layout_policy.perSource) */
  perSource?: Record<string, CaptionPerSource>;
}

export interface CaptionWordOverride {
  hidden?: boolean;
  text?: string;
  forceBreak?: boolean;
}

// ── Multi-lane subtitles (edit_captions three brothers positions / layout_policy / source_update)──
// One captions item can be linked to multiple "logical sources" (translation variants of different tracks/different speakers/same track),
// Each source is an independent rendering lane: its own word flow, position (anchor/slot), style and visibility.
// When sourceEntries exists, the multi-lane engine (lanes.ts) is used for rendering; otherwise, the original single-stream path is used (bytes remain unchanged).

/** One logical caption source = one render lane (source_set sources[] entry). */
export interface CaptionSourceEntry {
  /** stable sourceId — selector target + perSource key (source_list exposes it) */
  id: string;
  /** transcribed timeline item feeding this lane; manual lanes use a manual:* sentinel */
  itemId: string;
  /** Manual lane cues in absolute timeline milliseconds. One word is one cue. */
  words?: TranscriptWord[];
  /** stable 0-based visual order; legacy entries without it keep array order */
  trackOrder?: number;
  /** show this item's translation variant instead of the original words */
  variant?: { variantKind: 'translation'; languageCode: string };
  label?: string;
  /** default true */
  visible?: boolean;
  /** single-lane overlap arbitration (lower shows first; unset → list order) */
  priority?: number;
  /** pin to a manual-slots slot */
  slotId?: string;
  /** per-source placement (action=positions); unset → the shared block */
  anchor?: CaptionAnchor;
  offsetXRatio?: number;
  offsetYRatio?: number;
  widthRatio?: number;
  heightRatio?: number;
  /** per-source style overrides layered over template+styleOverride (source_update.style) */
  style?: CaptionStyleOverride;
}

/** How multiple sources share the screen (action=layout_policy). */
export type CaptionLayoutPolicy =
  | { mode: 'single-lane'; maxVisibleSources?: number }
  | { mode: 'auto-stack'; maxVisibleSources?: number }
  | { mode: 'manual-slots'; slots: CaptionSlot[] };

export interface CaptionSlot {
  id: string;
  anchor: CaptionAnchor;
  offsetXRatio?: number;
  offsetYRatio?: number;
  widthRatio?: number;
  heightRatio?: number;
}

/** Per-source render knobs keyed by sourceId (layout_policy.perSource). */
export interface CaptionPerSource {
  /** Lane own word limit per page(perSource.maxLines Approximate mapping of:This warehouse is paginated by word count,
   * No progressive layout engine → maxLines × Template wordsPerPage,Customize approximation and indicate)。 */
  maxLines?: number;
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
// segmenter (segmenter.ts, breakpoint scoring); unset → the old logic remains unchanged byte by byte.
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
    if (breakBefore?.has(i) && cur.length) flush(); // forceBreak: Start a new page before this word
    cur.push(words[i]);
    const next = words[i + 1];
    const bigGap = next ? next.start - words[i].end > GAP_MS : false;
    if (cur.length >= maxPhraseWords || SENTENCE_END.test(words[i].text) || bigGap) flush();
  }
  flush();
  return pages;
}

// Content-aware paging (P1-#3): forceBreak still has the highest priority - press breakBefore first to cut into hard pieces, and then
// Run segmentWords (punctuation/end of sentence/CJK particle/orphan word scoring, fallback and line break) in each block. only if
// The caller must explicitly provide maxCharsPerLine before going here; 21 presets are not passed by default, and the behavior remains unchanged (enabling presets one by one will be left for later).
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

// Kanji/kana/full-width sections: When the adjacent two sides are CJK, no spaces are inserted in the sentence (same inspiration as script serialization).
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Spell a page of words into a whole sentence of text:Do not insert adjacent spaces between Chinese characters,Use spaces between Latin words. render layer wholeLine Shared with sentence-by-sentence editing. */
export function joinCaptionWords(ws: { text: string }[]): string {
  let out = '';
  for (const w of ws) {
    if (!w.text) continue;
    if (out && !(CJK.test(out.slice(-1)) && CJK.test(w.text[0] ?? ''))) out += ' ';
    out += w.text;
  }
  return out;
}
