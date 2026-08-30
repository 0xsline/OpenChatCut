import type { TranscriptWord } from '../transcript/types.js';
import type { CaptionStyleOverride } from './styles.js';
import { segmentWords } from './segmenter.js';

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
  scale?: number;
  rotation?: number;
  opacity?: number;
}

// Captions = a styled singleton overlay burned onto the video, separate
// from the text editing surface. Words are paginated into "pages" and shown in
// sync with playback (timings are TIMELINE ms once resolved).
//
// Captions mirror an audio item's transcript. When that item is
// edited (words deleted / silence compressed) the caption words are re-projected
// onto the edited timeline (see retimeWords) — captions follow edits. If no item
// is referenced, `words` + `offsetFrames` provide a standalone (sample) source.
export type CaptionTemplate = 'plain' | 'black-bar' | 'persona' | 'off-the-wall' | 'the-french-dispatch' | 'dogme' | 'boyz-n-the-hood' | 'bubble-pop' | 'submagic' | 'story' | 'bili' | 'luxe' | 'noir' | 'atelier' | 'product' | 'signal' | 'studio' | 'white-card' | 'bold-outline' | 'deyi-card' | 'tiktok' | 'netflix';
export type CaptionPacing = 'word' | 'phrase';

/** Deterministic burn-in animation shared by Player preview and Remotion export. */
export type CaptionMotionPreset = 'none' | 'fade-up' | 'pop' | 'word-pop' | 'karaoke-pulse';

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
  /** Optional frame-derived motion. Missing and `none` both preserve the static legacy render. */
  motionPreset?: CaptionMotionPreset;
  /** audio item whose (edited) transcript drives the captions */
  sourceItemId?: string | null;
  /** MULTI-source merge — Captions can summarize all transcribed tracks: item ids whose (edited) transcripts
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
  /** Translation language label (for example, "Chinese") — display/regeneration hint. */
  translationLang?: string;
  /** translated phrase cues (timeline ms), aligned to the source phrases */
  translation?: TranslatedCue[];
  /** Timing fingerprint of the caption words the translation was built from.
   * Cues carry ABSOLUTE timeline ms, so any later edit that re-times the source
   * (word deletion, silence compression, moving the clip) leaves them pinned to
   * the old positions. Comparing this against the live fingerprint tells the UI
   * the translation is out of date instead of silently showing drifted text.
   * Absent on translations generated before this field existed — treated as
   * "unknown", never as stale. */
  translationFingerprint?: string;
  /** display a transcript VARIANT (translation / corrected pass) as the caption
   * text instead of the source words. Keys `sourceItemId`'s `variants` by id; the
   * variant only swaps each word's TEXT; timing stays with the source word. Only
   * applies on the single-source path (`sourceItemId`); the multi-source merge
   * ignores it (no single transcript to key a variant off). Unset = show source. */
  captionVariantId?: string;
  /** Per-word DISPLAY overrides for the captions overlay (hide / retext / force
   * a page break), WITHOUT touching the transcript or its timing. Existing
   * numeric keys remain readable; new writes also persist `wordRef` so edits
   * continue to follow the same source word after regrouping or source reorder. */
  wordOverrides?: Record<number, CaptionWordOverride>;
  /** custom style fields layered OVER the template preset (edit_captions
   * action=style). Only what the user set; unset fields inherit the preset. */
  styleOverride?: CaptionStyleOverride;
  /** whole-block placement (edit_captions action=layout). Unset = the
   * template's default bottom-center. */
  layout?: CaptionLayout;
  /** Multi-lane source list (sourceScope.sources). Rendering takes a multi-lane engine when present;
   * Mutually exclusive with old `sources` (single stream merge), old fields should be cleared when writing. */
  sourceEntries?: CaptionSourceEntry[];
  /** Multi-source screen allocation policy (action=layout_policy); null/not set → auto-stack. */
  layoutPolicy?: CaptionLayoutPolicy | null;
  /** per-source rendering coverage, key = sourceEntries[].id(layout_policy.perSource) */
  perSource?: Record<string, CaptionPerSource>;
}

export interface CaptionWordOverride {
  /** Opaque identity returned by read_captions for the source word this override targets. */
  wordRef?: string;
  hidden?: boolean;
  text?: string;
  forceBreak?: boolean;
  /** Display-only timing shift for moving generated cues independently of source media. */
  timingOffsetMs?: number;
}

// ──Multi-lane captions (edit_captions three brothers positions / layout_policy / source_update)──
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
  scale?: number;
  rotation?: number;
  opacity?: number;
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
  /** The upper limit of the number of words per page of the lane itself (approximate mapping of perSource.maxLines: paging according to the number of words in this codebase,
   * No progressive typesetting engine → maxLines × template wordsPerPage, customized approximation and noted). */
  maxLines?: number;
}

export interface CaptionPage {
  words: TranscriptWord[];
  start: number; // ms
  end: number; // ms
}

const MAX_PHRASE_WORDS = 6;
export const LINGER_MS = 1500;
/** Shared preview/export contract: phrase pages fit at most two estimated visual lines. */
export const CAPTION_MAX_VISUAL_LINES = 2;
export const CAPTION_MAX_CHARS_PER_LINE = 24;
// Group words into display pages. Phrase pacing always uses the content-aware
// segmenter; `breakBefore` boundaries are cut first and therefore cannot be
// crossed by semantic regrouping. The character budget is multiplied by the
// clamped visual-line count, so overflow moves to another timed page rather
// than being truncated.
export function paginate(
  words: TranscriptWord[],
  pacing: CaptionPacing,
  maxPhraseWords = MAX_PHRASE_WORDS,
  breakBefore?: Set<number>,
  maxCharsPerLine = CAPTION_MAX_CHARS_PER_LINE,
  maxLines = CAPTION_MAX_VISUAL_LINES,
): CaptionPage[] {
  if (pacing === 'word') return words.map((w) => ({ words: [w], start: w.start, end: w.end }));
  const requestedLines = Number.isFinite(maxLines) ? Math.floor(maxLines) : CAPTION_MAX_VISUAL_LINES;
  const lines = Math.max(1, Math.min(CAPTION_MAX_VISUAL_LINES, requestedLines));
  const chars = Number.isFinite(maxCharsPerLine) && maxCharsPerLine > 0
    ? maxCharsPerLine
    : CAPTION_MAX_CHARS_PER_LINE;
  return paginateContentAware(words, maxPhraseWords, breakBefore, chars * lines);
}

// Forced page breaks split the input into hard chunks before content-aware
// segmentation. Intl.Segmenter enriches CJK word boundaries when available;
// segmentWords has a deterministic scoring fallback when it is absent.
function paginateContentAware(words: TranscriptWord[], maxPhraseWords: number, breakBefore: Set<number> | undefined, maxCharsPerPage: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  const cuts = [...(breakBefore ?? [])].filter((i) => i > 0 && i < words.length).sort((a, b) => a - b);
  let chunkStart = 0;
  for (const boundary of [...cuts, words.length]) {
    const chunk = words.slice(chunkStart, boundary);
    const starts = segmentWords(chunk, { maxCharsPerLine: maxCharsPerPage, wordsPerPage: maxPhraseWords });
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

// Kanji/Kana/Full-width section: No spaces are inserted when the adjacent sides are CJK (same inspiration as script serialization).
const CJK = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Spell a page of words into a whole sentence of text: no spaces are inserted between adjacent Chinese words, and spaces are used between Latin words. The rendering layer wholeLine is shared with line-by-line editing. */
export function joinCaptionWords(ws: { text: string }[]): string {
  let out = '';
  for (const w of ws) {
    if (!w.text) continue;
    if (out && !(CJK.test(out.slice(-1)) && CJK.test(w.text[0] ?? ''))) out += ' ';
    out += w.text;
  }
  return out;
}
