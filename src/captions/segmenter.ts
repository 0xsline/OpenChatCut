// Content-aware caption segmentation engine - line breaking/pagination based on semantics (see segmenterData.ts for word list/weights, do not change).
// Greedy line break path: collect breakpoint candidates → budget (number of words/characters) reaches the top → select the candidate with the highest score to fallback to line break
// → Post-processing (pull back the particle at the beginning of the line).
//
// Two design trade-offs (both specified by task specifications):
// 1. No px width + original number of characters double budget (factor table
// CJK:LATIN = 1:0.55); This engine converts it into a single "character unit" budget: CJK character = 2, the rest = 1.
// 2. Non-CJK + wordsPerPage does not use pure counting paging (
// No scoring); this engine will also perform scoring rollback when the word budget reaches the top according to the task specifications.
// Not implemented: Pure English single-row DP optimizer (cost table) and row balancing post-processing - will be added when enabled one by one by default.
import {
  CJK_PARTICLES, CJK_PUNCT, CJK_WORD_SUFFIXES, LATIN_BREAK_PATTERNS, LATIN_FUNCTION_WORDS,
  LATIN_PENALTY_PATTERNS, LATIN_QUANTIFIERS, MODAL_PARTICLES, NO_LINE_START, ORPHAN_PICK_DEMOTION,
  PAUSE_MIN_MS, PAUSE_SUPPRESSED_CONNECTORS, PAUSE_SUPPRESSED_MIN_MS, QUESTION_HEAD, QUESTION_TAIL,
  QUESTION_TAIL_EXCLUDE, SHORT_FUNCTION_WORD, pauseBreakPriority,
} from './segmenterData.js';

/** Input word (TranscriptWord structure is compatible; pause breakpoint does not participate when there is no timestamp). */
export interface SegmentWord {
  text: string;
  start?: number; // ms
  end?: number; // ms
}

export interface SegmentOpts {
  /** Character unit budget (CJK=2/rest=1, see file header comment). If not, it will only be paged by the number of words. */
  maxCharsPerLine?: number;
  /** Word budget per page (punctuation words are not counted). Ignored when CJK dominant text is given and maxCharsPerLine is given. */
  wordsPerPage: number;
}

interface BreakPoint {
  wordIndex: number; // The breakpoint is after the word
  priority: number;
  orphanRisk: boolean;
}

const CJK_START = /[㐀-鿿぀-ヿ가-힯]/u;
const PUNCT_ONLY = /^[\p{P}]+$/u;
const CJK_PUNCT_CHARS = /[，。！？；：、“”‘’（）【】《》「」『』〈〉〔〕｛｝〖〗…—～·]|[｡､]/;
const LATIN_PUNCT_CHARS = /[.,!?;:'"()[\]{}/\\@#$%^&*\-+=<>|~`]/;

type WordScript = 'punctuation' | 'number' | 'cjk' | 'latin' | 'mixed';

/** Character classification: 0=CJK 1=Lowercase Latin 2=Uppercase Latin 3=Numbers 4=Punctuation 5=Space 6=Others. */
function charClass(ch: string): number {
  if (!ch) return 6;
  const c = ch.charCodeAt(0);
  if ((c >= 19968 && c <= 40959) || (c >= 13312 && c <= 19903) || (c >= 12352 && c <= 12447)
    || (c >= 12448 && c <= 12543) || (c >= 44032 && c <= 55215) || (c >= 4352 && c <= 4607)
    || (c >= 12592 && c <= 12687) || (c >= 12784 && c <= 12799)) return 0;
  if (c >= 65 && c <= 90) return 2;
  if (c >= 97 && c <= 122) return 1;
  if (c >= 192 && c <= 255) return c === 215 || c === 247 ? 4 : 1;
  if (c >= 256 && c <= 591) return 1;
  if ((c >= 48 && c <= 57) || (c >= 65296 && c <= 65305)) return 3;
  if (ch === ' ' || ch === '\u00A0' || ch === '\u3000') return 5;
  if (CJK_PUNCT_CHARS.test(ch) || LATIN_PUNCT_CHARS.test(ch)) return 4;
  return 6; // ponytail: Agent pairs will no longer be subdivided and will be calculated according to other
}

function hasCjkChar(text: string): boolean {
  for (const ch of text) if (charClass(ch) === 0) return true;
  return false;
}

function isPunctOnly(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && PUNCT_ONLY.test(t);
}

/** The language classification of the word. */
function wordScript(text: string): WordScript {
  let cjk = 0, latin = 0, num = 0, punct = 0;
  for (const ch of text) {
    const cls = charClass(ch);
    if (cls === 0) cjk++;
    else if (cls === 1 || cls === 2) latin++;
    else if (cls === 3) num++;
    else if (cls === 4) punct++;
  }
  const total = cjk + latin + num + punct;
  if (total === 0 || punct === total) return 'punctuation';
  if (num > 0 && num + punct === total) return 'number';
  const letters = cjk + latin;
  if (letters > 0) {
    if (cjk > letters * 0.5) return 'cjk';
    if (latin > letters * 0.5) return 'latin';
  }
  if (cjk > 0 && latin === 0) return 'cjk';
  if (latin > 0 && cjk === 0) return 'latin';
  return 'mixed';
}

/** Seam text between two words. */
function joinerBetween(left: SegmentWord, right: SegmentWord, ls: WordScript, rs: WordScript): string {
  if (/\s$/u.test(left.text) || /^\s/u.test(right.text)) return '';
  if (!ls || (ls === 'cjk' && rs === 'cjk')) return '';
  if ((ls === 'latin' && rs === 'latin') || (ls === 'cjk' && rs === 'latin') || (ls === 'latin' && rs === 'cjk')) return ' ';
  if (ls === 'mixed' || rs === 'mixed') return ls !== 'punctuation' && rs !== 'punctuation' ? ' ' : '';
  if (ls === 'number' || rs === 'number') {
    return ls === 'latin' || rs === 'latin' || ls === 'cjk' || rs === 'cjk' ? ' ' : '';
  }
  if (ls === 'punctuation' || rs === 'punctuation') return '';
  return ' ';
}

/** If the CJK ratio is ≥0.3, it is deemed CJK dominant. */
export function isCjkDominant(text: string): boolean {
  let cjk = 0, letters = 0;
  for (const ch of text) {
    const cls = charClass(ch);
    if (cls === 0) { cjk++; letters++; } else if (cls === 1 || cls === 2 || cls === 3) letters++;
  }
  return letters > 0 && cjk / letters >= 0.3;
}

interface LatinBreak { isOrphanRisk: boolean; position: number; score: number }

/** English breakpoint scorer: traverse adjacent word pairs, basic 20 points,
 * LATIN_BREAK_PATTERNS points for hit, LATIN_PENALTY_PATTERNS penalty for first hit, end of sentence /[.!?]$/ +30, SHORT_FUNCTION_WORD −40 for orphan words and remaining words ≤2. */
export function scoreLatinBreaks(text: string): LatinBreak[] {
  const words = text.split(' ');
  const out: LatinBreak[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const cur = words[i];
    const next = words[i + 1];
    const rest = words.slice(i + 1);
    const position = words.slice(0, i + 1).join(' ').length;
    let score = 20;
    for (const p of LATIN_BREAK_PATTERNS) if (p.pattern.test(cur)) { score = p.score; break; }
    const pair = `${cur} ${next}`;
    for (const p of LATIN_PENALTY_PATTERNS) if (p.pattern.test(pair)) { score -= p.penalty; break; }
    const orphan = SHORT_FUNCTION_WORD.test(next) && rest.length <= 2;
    if (orphan) score -= 40;
    if (/[.!?]$/.test(cur)) score += 30;
    out.push({ isOrphanRisk: orphan, position, score: Math.max(0, score) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** CJK punctuation breakpoint priority: end of sentence 100 / comma 80 / quotation mark 70.*/
function cjkPunctPriority(text: string): number | null {
  const last = text[text.length - 1];
  if ((CJK_PUNCT.sentenceEnd as readonly string[]).includes(last)) return 100;
  if ((CJK_PUNCT.clauseBreak as readonly string[]).includes(last)) return 80;
  if ((CJK_PUNCT.quoteEnd as readonly string[]).includes(last)) return 70;
  return null;
}

/** Postmodal break: the last word of the left word is ∈ MODAL_PARTICLES and the right word starts with CJK.*/
function isModalBreak(left: string, right: string): boolean {
  const tail = left.trim().at(-1);
  const head = right.trim().at(0);
  if (!tail || !head) return false;
  return (MODAL_PARTICLES as readonly string[]).includes(tail) && CJK_START.test(head);
}

/** CJK orphan word avoidance: the last word of the left word or the first word of the right word ∈ CJK_PARTICLES → orphanRisk.*/
function isCjkOrphanPair(left: string, right: string): boolean {
  return (CJK_PARTICLES as readonly string[]).includes(left[left.length - 1])
    || (CJK_PARTICLES as readonly string[]).includes(right[0]);
}

function normalizeLatin(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** English orphan word risk categories.*/
function hasLatinOrphanRisk(left: string, right: string): boolean {
  if (normalizeLatin(right) === 'of'
    && (LATIN_QUANTIFIERS as readonly string[]).includes(normalizeLatin(left))) return true; // LATIN_QUANTIFIERS
  return (LATIN_FUNCTION_WORDS as readonly string[]).includes(normalizeLatin(left));
}

/** When the conjunction has a comma, 150–400ms. Small pauses do not count as breakpoints.*/
function isPauseSuppressedPair(left: string, right: string): boolean {
  if (!(PAUSE_SUPPRESSED_CONNECTORS as readonly string[]).includes(normalizeLatin(left))
    || !/[,;:][\s"'”’）)\]}》」』】]*$/u.test(left.trim())) return false;
  return normalizeLatin(right).length > 0;
}

/** All CJK characters of the word list in order, plus per-word prefix counts —
 * computed once so isQuestionBreak never rebuilds a text prefix per pair (O(n²) → O(n)). */
interface CjkIndex {
  chars: string[];
  /** prefix[i] = number of CJK characters in words[0..i-1] (length = words.length+1) */
  prefix: number[];
}

function cjkIndex(words: SegmentWord[]): CjkIndex {
  const chars: string[] = [];
  const prefix: number[] = [0];
  for (const word of words) {
    for (const ch of word.text) if (charClass(ch) === 0) chars.push(ch);
    prefix.push(chars.length);
  }
  return { chars, prefix };
}

/** CJK interrogative breakpoint:
 * "...is there something/is it who..." followed by personal/chronological words → Priority 58.
 * tail = last 12 CJK chars of words[0..idx], head = first 6 CJK chars of words[idx+1..idx+4]. */
function isQuestionBreak(words: SegmentWord[], idx: number, cjk: CjkIndex): boolean {
  const tailStart = Math.max(0, cjk.prefix[idx + 1]! - 12);
  const tail = cjk.chars.slice(tailStart, cjk.prefix[idx + 1]).join('');
  const headStart = cjk.prefix[idx + 1]!;
  const headEnd = cjk.prefix[Math.min(words.length, idx + 5)]!;
  const head = cjk.chars.slice(headStart, Math.min(headEnd, headStart + 6)).join('');
  if (!tail || !head || QUESTION_TAIL_EXCLUDE.test(tail) || !QUESTION_TAIL.test(tail)) return false;
  return QUESTION_HEAD.test(head);
}

/** "The relationship between idx−1 and idx is inseparable":
 * Seamless and Intl.Segmenter determines that it falls within the same CJK word (or hits the CJK_WORD_SUFFIXES affix). The entire text is segmented only once.*/
function makeCannotSplit(words: SegmentWord[], scripts: WordScript[]): (idx: number) => boolean {
  let text = '';
  const wordStart: number[] = [];
  const joinerLen: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const j = i > 0 ? joinerBetween(words[i - 1], words[i], scripts[i - 1], scripts[i]) : '';
    joinerLen.push(j.length);
    text += j;
    wordStart.push(text.length);
    text += words[i].text;
  }
  let segs: Array<{ start: number; end: number; wordLike: boolean; cjk: boolean }> | null = null;
  const segments = () => {
    if (!segs) {
      segs = typeof Intl.Segmenter === 'function'
        ? Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text), (s) => ({
            start: s.index, end: s.index + s.segment.length, wordLike: !!s.isWordLike, cjk: hasCjkChar(s.segment),
          }))
        : [];
    }
    return segs;
  };
  return (idx: number): boolean => {
    if (idx <= 0 || idx >= words.length) return false;
    if (joinerLen[idx] > 0) return false;
    const pos = wordStart[idx];
    const leftCh = Array.from(text.slice(0, pos).trimEnd()).at(-1) ?? '';
    const rightCh = Array.from(text.slice(pos).trimStart()).at(0) ?? '';
    if (charClass(leftCh) !== 0 || charClass(rightCh) !== 0) return false;
    if (typeof Intl.Segmenter !== 'function') return false;
    for (const s of segments()) if (s.start < pos && s.end > pos) return s.wordLike && s.cjk;
    return (CJK_WORD_SUFFIXES as readonly string[]).includes(rightCh);
  };
}

/** English adjacent word pair breakpoint: ±2 word window run scoreLatinBreaks, whichever is closest to the breakpoint
 * (<10 characters); otherwise, 40 points are safe.*/
function latinPairBreak(words: SegmentWord[], idx: number): BreakPoint {
  const from = Math.max(0, idx - 2);
  const windowText = words.slice(from, Math.min(words.length, idx + 3)).map((w) => w.text).join(' ');
  const target = words.slice(from, idx + 1).map((w) => w.text).join(' ').length;
  let nearest: LatinBreak | null = null;
  let dist = Infinity;
  for (const b of scoreLatinBreaks(windowText)) {
    const d = Math.abs(b.position - target);
    if (d < dist) { dist = d; nearest = b; }
  }
  if (nearest && dist < 10) return { wordIndex: idx, priority: nearest.score, orphanRisk: nearest.isOrphanRisk };
  return { wordIndex: idx, priority: 40, orphanRisk: hasLatinOrphanRisk(words[idx].text, words[idx + 1].text) };
}

/** Index of the first breakpoint with wordIndex === r among the entries pushed
 * for this pair. Breakpoints are only ever appended for the current r, so a
 * full-array scan per pair would be quadratic (same result, O(1) scope). */
function firstBreakAt(bps: BreakPoint[], from: number, r: number): number {
  for (let b = from; b < bps.length; b++) if (bps[b]!.wordIndex === r) return b;
  return -1;
}

/** Whether this pair already has a breakpoint with priority >= 40 (scoped to the
 * entries pushed for the current r, same rationale as firstBreakAt). */
function hasStrongBreak(bps: BreakPoint[], from: number, r: number): boolean {
  for (let b = from; b < bps.length; b++) {
    const bp = bps[b]!;
    if (bp.wordIndex === r && bp.priority >= 40) return true;
  }
  return false;
}

/** Breakpoint candidate collection.*/
function collectBreakPoints(words: SegmentWord[], scripts: WordScript[], cannotSplit: (i: number) => boolean): BreakPoint[] {
  const cjk = cjkIndex(words);
  const bps: BreakPoint[] = [];
  for (let r = 0; r < words.length - 1; r++) {
    const left = words[r];
    const right = words[r + 1];
    if (isPunctOnly(right.text)) continue; // Punctuation words never start running
    const firstNew = bps.length; // only entries pushed in this iteration can have wordIndex === r
    const blocked = cannotSplit(r + 1);
    const punct = cjkPunctPriority(left.text);
    if (punct !== null) {
      bps.push({ wordIndex: r, priority: punct, orphanRisk: isCjkOrphanPair(left.text, right.text) });
    } else if (isModalBreak(left.text, right.text)) {
      bps.push({ wordIndex: r, priority: 60, orphanRisk: false });
    } else if (isQuestionBreak(words, r, cjk)) {
      bps.push({ wordIndex: r, priority: 58, orphanRisk: false });
    }
    const isBoundary = (scripts[r] === 'cjk' && scripts[r + 1] === 'latin') || (scripts[r] === 'latin' && scripts[r + 1] === 'cjk');
    if (!blocked && isBoundary) bps.push({ wordIndex: r, priority: 50, orphanRisk: false });
    if (!blocked && scripts[r] === 'latin' && scripts[r + 1] === 'latin') bps.push(latinPairBreak(words, r));
    const gap = right.start !== undefined && left.end !== undefined ? right.start - left.end : 0;
    if (!blocked && gap >= PAUSE_MIN_MS && (!isPauseSuppressedPair(left.text, right.text) || gap >= PAUSE_SUPPRESSED_MIN_MS)) {
      const priority = pauseBreakPriority(gap);
      const at = firstBreakAt(bps, firstNew, r);
      if (at < 0) bps.push({ wordIndex: r, priority, orphanRisk: false });
      else if (bps[at]!.priority < priority) bps[at] = { ...bps[at]!, priority };
    }
    if (!blocked && !hasStrongBreak(bps, firstNew, r)) {
      const risk = isCjkOrphanPair(left.text, right.text) || hasLatinOrphanRisk(left.text, right.text);
      bps.push({ wordIndex: r, priority: 30, orphanRisk: risk });
    }
  }
  return bps;
}

/** Select the optimal breakpoint: effective score = priority − orphan word downgraded by 30,
 * Those with the same score are taken to the back; those that cannot be separated are eliminated.*/
function pickBreak(bps: BreakPoint[], from: number, to: number, cannotSplit: (i: number) => boolean): BreakPoint | null {
  const cands = bps.filter((b) => b.wordIndex >= from && b.wordIndex <= to && !cannotSplit(b.wordIndex + 1));
  if (cands.length === 0) return null;
  const sorted = [...cands].sort((a, b) => {
    const ea = a.priority - (a.orphanRisk ? ORPHAN_PICK_DEMOTION : 0);
    const eb = b.priority - (b.orphanRisk ? ORPHAN_PICK_DEMOTION : 0);
    return eb !== ea ? eb - ea : b.wordIndex - a.wordIndex;
  });
  return sorted[0];
}

/** Character unit: CJK=2, the remaining characters are 1 each (see file header deviation description 1).*/
function unitsOf(text: string): number {
  let units = 0;
  for (const ch of text) units += charClass(ch) === 0 ? 2 : 1;
  return units;
}

function measure(words: SegmentWord[], scripts: WordScript[], from: number, to: number): { units: number; count: number } {
  let units = 0, count = 0;
  for (let i = from; i <= to; i++) {
    if (i > from) units += unitsOf(joinerBetween(words[i - 1], words[i], scripts[i - 1], scripts[i]));
    units += unitsOf(words[i].text);
    if (!isPunctOnly(words[i].text)) count++;
  }
  return { units, count };
}

/** Pull back the first word of a line: the first word of a certain page starts with NO_LINE_START
 * When the particle begins, find the detachable bit from the end of the previous page and pull the word into this page (both pages must still be within the budget).*/
function pullParticleForward(
  words: SegmentWord[], scripts: WordScript[], starts: number[],
  cannotSplit: (i: number) => boolean, maxUnits: number | undefined, wordsPerPage: number,
): number[] {
  const fits = (from: number, to: number): boolean => {
    const { units, count } = measure(words, scripts, from, to);
    return (maxUnits === undefined || units <= maxUnits) && count <= wordsPerPage;
  };
  const out = [...starts];
  for (let k = 1; k < out.length; k++) {
    const cur = out[k];
    const prev = out[k - 1];
    const firstChar = Array.from(words[cur]?.text.trim() ?? '').at(0) ?? '';
    if (!firstChar || !(NO_LINE_START as readonly string[]).includes(firstChar)) continue;
    if (cur - prev < 2) continue;
    const end = (out[k + 1] ?? words.length) - 1;
    for (let o = cur - 1; o > prev; o--) {
      if (cannotSplit(o)) continue;
      if (fits(prev, o - 1) && fits(o, end)) { out[k] = o; break; }
    }
  }
  return out;
}

/** Content-aware segmentation: Returns the starting word subscript of each page (the homepage is always 0).
 * When the budget reaches the top (number of words or character units), select the breakpoint with the highest score in the current page window to go back and break the line;
 * Punctuation words will never open the page; stuck CJK words (the same word as Intl.Segmenter) will not be hard to open.*/
export function segmentWords(words: SegmentWord[], opts: SegmentOpts): number[] {
  if (words.length === 0) return [];
  const scripts = words.map((w) => wordScript(w.text));
  const cannotSplit = makeCannotSplit(words, scripts);
  const bps = collectBreakPoints(words, scripts, cannotSplit);
  const maxUnits = opts.maxCharsPerLine;
  // When CJK dominates and wordsPerPage>1, the word count budget is left blank.
  const cjkText = isCjkDominant(words.map((w) => w.text).join(''));
  const wordsPerPage = maxUnits !== undefined && cjkText && opts.wordsPerPage > 1
    ? Infinity : Math.max(1, opts.wordsPerPage);
  const starts = [0];
  let pageStart = 0, units = 0, count = 0;
  for (let i = 0; i < words.length; i++) {
    const punct = isPunctOnly(words[i].text);
    const joiner = i > pageStart ? joinerBetween(words[i - 1], words[i], scripts[i - 1], scripts[i]) : '';
    const nextUnits = units + unitsOf(joiner) + unitsOf(words[i].text);
    const nextCount = count + (punct ? 0 : 1);
    const over = (maxUnits !== undefined && nextUnits > maxUnits) || nextCount > wordsPerPage;
    if (over && !punct && i > pageStart) {
      const best = pickBreak(bps, pageStart, i - 1, cannotSplit);
      if (best) {
        pageStart = best.wordIndex + 1;
        starts.push(pageStart);
        ({ units, count } = measure(words, scripts, pageStart, i));
      } else if (!cannotSplit(i)) {
        pageStart = i;
        starts.push(i);
        units = unitsOf(words[i].text);
        count = 1;
      } else {
        units = nextUnits; // Sticky words cannot be removed and budget overruns are tolerated
        count = nextCount;
      }
    } else {
      units = nextUnits;
      count = nextCount;
    }
  }
  return pullParticleForward(words, scripts, starts, cannotSplit, maxUnits, wordsPerPage);
}
