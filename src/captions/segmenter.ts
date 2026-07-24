// Content-aware subtitle segmentation engine - line breaking/pagination based on semantics (see segmenterData.ts for word list/weights, do not change).
// Greedy line break path: collect breakpoint candidates → budget (number of words/characters) reaches the top → select the candidate with the highest score to fallback to line break
// → Post-processing (pulling back the particle at the beginning of the line).
//
// Two design trade-offs (both specified by task specifications):
// 1. No px width + original number of characters double budget (factor table
//    CJK:LATIN = 1:0.55); This engine converts it into a single "character unit" budget: CJK characters = 2, the rest = 1.
// 2. Non-CJK + wordsPerPage does not use pure count paging (
//    No scoring); this engine will also perform scoring rollback when the word budget reaches the top according to the task specifications.
// Not implemented: Pure English single-row DP optimizer (cost table) and row balancing post-processing - will be added when enabled one by one by default.
import {
  CJK_PARTICLES, CJK_PUNCT, CJK_WORD_SUFFIXES, LATIN_BREAK_PATTERNS, LATIN_FUNCTION_WORDS,
  LATIN_PENALTY_PATTERNS, LATIN_QUANTIFIERS, MODAL_PARTICLES, NO_LINE_START, ORPHAN_PICK_DEMOTION,
  PAUSE_MIN_MS, PAUSE_SUPPRESSED_CONNECTORS, PAUSE_SUPPRESSED_MIN_MS, QUESTION_HEAD, QUESTION_TAIL,
  QUESTION_TAIL_EXCLUDE, SHORT_FUNCTION_WORD, pauseBreakPriority,
} from './segmenterData';

/** Enter word(TranscriptWord Architecturally compatible;The pause breakpoint does not participate when there is no timestamp.)。 */
export interface SegmentWord {
  text: string;
  start?: number; // ms
  end?: number; // ms
}

export interface SegmentOpts {
  /** Character unit budget(CJK=2/The rest=1,See file header comments). If not, it will only be paged by the number of words. */
  maxCharsPerLine?: number;
  /** word budget per page(Punctuation words are not counted)。CJK Leading text and given maxCharsPerLine Ignored. */
  wordsPerPage: number;
}

interface BreakPoint {
  wordIndex: number; // The breakpoint is after the word
  priority: number;
  orphanRisk: boolean;
}

const CJK_START = /[㐀-Yi぀-ヿ가-힯]/u;
const PUNCT_ONLY = /^[\p{P}]+$/u;
const CJK_PUNCT_CHARS = /[，。！？；：、“”‘’（）【】《》「」『』〈〉〔〕｛｝〖〗…—～·]|[｡､]/;
const LATIN_PUNCT_CHARS = /[.,!?;:'"()[\]{}/\\@#$%^&*\-+=<>|~`]/;

type WordScript = 'punctuation' | 'number' | 'cjk' | 'latin' | 'mixed';

/** Character classification:0=CJK 1=lowercase Latin 2=Uppercase Latin 3=numbers 4=punctuation 5=space 6=Others. */
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

/** Literary classification of words. */
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

/** CJK Proportion ≥0.3 judged as CJK Dominate. */
export function isCjkDominant(text: string): boolean {
  let cjk = 0, letters = 0;
  for (const ch of text) {
    const cls = charClass(ch);
    if (cls === 0) { cjk++; letters++; } else if (cls === 1 || cls === 2 || cls === 3) letters++;
  }
  return letters > 0 && cjk / letters >= 0.3;
}

interface LatinBreak { isOrphanRisk: boolean; position: number; score: number }

/** English breakpoint scorer:Traverse adjacent word pairs,Basics 20 points,
 * LATIN_BREAK_PATTERNS Hit change points,LATIN_PENALTY_PATTERNS First hit penalty, end of sentence /[.!?]$/ +30、SHORT_FUNCTION_WORD Lone words and remaining words ≤2 time −40。 */
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

/** CJK Punctuation breakpoint priority:end of sentence 100 / Tease 80 / enclosed in quotation marks 70。 */
function cjkPunctPriority(text: string): number | null {
  const last = text[text.length - 1];
  if ((CJK_PUNCT.sentenceEnd as readonly string[]).includes(last)) return 100;
  if ((CJK_PUNCT.clauseBreak as readonly string[]).includes(last)) return 80;
  if ((CJK_PUNCT.quoteEnd as readonly string[]).includes(last)) return 70;
  return null;
}

/** modal participle:The last character of left word ∈ MODAL_PARTICLES And the right word is with CJK Beginning. */
function isModalBreak(left: string, right: string): boolean {
  const tail = left.trim().at(-1);
  const head = right.trim().at(0);
  if (!tail || !head) return false;
  return (MODAL_PARTICLES as readonly string[]).includes(tail) && CJK_START.test(head);
}

/** CJK Solitary word avoidance:The last character of the left word or the first character of the right word ∈ CJK_PARTICLES → orphanRisk。 */
function isCjkOrphanPair(left: string, right: string): boolean {
  return (CJK_PARTICLES as readonly string[]).includes(left[left.length - 1])
    || (CJK_PARTICLES as readonly string[]).includes(right[0]);
}

function normalizeLatin(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** English orphan word risk categories. */
function hasLatinOrphanRisk(left: string, right: string): boolean {
  if (normalizeLatin(right) === 'of'
    && (LATIN_QUANTIFIERS as readonly string[]).includes(normalizeLatin(left))) return true; // LATIN_QUANTIFIERS
  return (LATIN_FUNCTION_WORDS as readonly string[]).includes(normalizeLatin(left));
}

/** When the conjunction contains a comma 150–400ms Small pauses do not count as breakpoints. */
function isPauseSuppressedPair(left: string, right: string): boolean {
  if (!(PAUSE_SUPPRESSED_CONNECTORS as readonly string[]).includes(normalizeLatin(left))
    || !/[,;:][\s"'”’）)\]}》」』】]*$/u.test(left.trim())) return false;
  return normalizeLatin(right).length > 0;
}

/** CJK interrogative breakpoint:
 * "...what's there/Is it who..." followed by the person/temporal words → priority 58。 */
function isQuestionBreak(words: SegmentWord[], idx: number): boolean {
  const cjkOnly = (from: number, to: number): string =>
    Array.from(words.slice(from, to).map((w) => w.text).join('')).filter((ch) => charClass(ch) === 0).join('');
  const tail = cjkOnly(0, idx + 1).slice(-12);
  const head = cjkOnly(idx + 1, Math.min(words.length, idx + 5)).slice(0, 6);
  if (!tail || !head || QUESTION_TAIL_EXCLUDE.test(tail) || !QUESTION_TAIL.test(tail)) return false;
  return QUESTION_HEAD.test(head);
}

/** 「idx−1 with idx cannot be separated":
 * Seamless and Intl.Segmenter Judgment falls in the same CJK within the word(or hit CJK_WORD_SUFFIXES affix). The entire text is segmented only once. */
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

/** English adjacent word pair breakpoints:±2 word window run scoreLatinBreaks,Get closest to breakpoint
 * (<10 character)of scoring;Otherwise, keep it secret 40 points safe。 */
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

/** Breakpoint candidate collection. */
function collectBreakPoints(words: SegmentWord[], scripts: WordScript[], cannotSplit: (i: number) => boolean): BreakPoint[] {
  const bps: BreakPoint[] = [];
  for (let r = 0; r < words.length - 1; r++) {
    const left = words[r];
    const right = words[r + 1];
    if (isPunctOnly(right.text)) continue; // Punctuation words never start running
    const blocked = cannotSplit(r + 1);
    const punct = cjkPunctPriority(left.text);
    if (punct !== null) {
      bps.push({ wordIndex: r, priority: punct, orphanRisk: isCjkOrphanPair(left.text, right.text) });
    } else if (isModalBreak(left.text, right.text)) {
      bps.push({ wordIndex: r, priority: 60, orphanRisk: false });
    } else if (isQuestionBreak(words, r)) {
      bps.push({ wordIndex: r, priority: 58, orphanRisk: false });
    }
    const isBoundary = (scripts[r] === 'cjk' && scripts[r + 1] === 'latin') || (scripts[r] === 'latin' && scripts[r + 1] === 'cjk');
    if (!blocked && isBoundary) bps.push({ wordIndex: r, priority: 50, orphanRisk: false });
    if (!blocked && scripts[r] === 'latin' && scripts[r + 1] === 'latin') bps.push(latinPairBreak(words, r));
    const gap = right.start !== undefined && left.end !== undefined ? right.start - left.end : 0;
    if (!blocked && gap >= PAUSE_MIN_MS && (!isPauseSuppressedPair(left.text, right.text) || gap >= PAUSE_SUPPRESSED_MIN_MS)) {
      const priority = pauseBreakPriority(gap);
      const at = bps.findIndex((b) => b.wordIndex === r);
      if (at < 0) bps.push({ wordIndex: r, priority, orphanRisk: false });
      else if (bps[at].priority < priority) bps[at] = { ...bps[at], priority };
    }
    if (!blocked && !bps.some((b) => b.wordIndex === r && b.priority >= 40)) {
      const risk = isCjkOrphanPair(left.text, right.text) || hasLatinOrphanRisk(left.text, right.text);
      bps.push({ wordIndex: r, priority: 30, orphanRisk: risk });
    }
  }
  return bps;
}

/** Choose the best breakpoint:Valid points = priority − Solitary words reduced in power 30,
 * Those with the same score take the last place;Remove the parts that cannot be removed. */
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

/** character unit:CJK=2,each remaining character 1(See file header deviation description 1)。 */
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

/** Pull back the initial particle of line:The first word of a certain page starts with NO_LINE_START
 * At the beginning of the particle,Find the detachable word from the end of the previous page and pull it into this page.(Both pages must still be within budget)。 */
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

/** content-aware segmentation:Return the starting word subscript of each page(Home pageHengwei 0)。
 * Budget hits ceiling(Number of words or character units)When selecting the breakpoint with the highest score in the current page window, go back and break the line.;
 * Punctuation words never open the page;sticky CJK word(Intl.Segmenter Same word)No forced dismantling. */
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
