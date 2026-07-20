// 内容感知字幕分段引擎——按语义断行/分页(词表/权重见 segmenterData.ts,勿改动)。
// 贪心断行路径:收集断点候选 → 预算(词数/字符)触顶 → 选分数最高候选回退断行
// → 后处理(行首助词回拉)。
//
// 两点设计取舍(均为任务规格指定):
// 1. 不用 px 宽 + 原始字符数双预算(因子表
//    CJK:LATIN = 1:0.55);本引擎折成单一「字符单位」预算:CJK 字符=2、其余=1。
// 2. 非 CJK + wordsPerPage 不走纯计数分页(
//    不打分);本引擎按任务规格对词数预算触顶同样走打分回退。
// 未实现:纯英文单行 DP 优化器(代价表)与行均衡后处理——预设逐个启用时再补。
import {
  CJK_PARTICLES, CJK_PUNCT, CJK_WORD_SUFFIXES, LATIN_BREAK_PATTERNS, LATIN_FUNCTION_WORDS,
  LATIN_PENALTY_PATTERNS, LATIN_QUANTIFIERS, MODAL_PARTICLES, NO_LINE_START, ORPHAN_PICK_DEMOTION,
  PAUSE_MIN_MS, PAUSE_SUPPRESSED_CONNECTORS, PAUSE_SUPPRESSED_MIN_MS, QUESTION_HEAD, QUESTION_TAIL,
  QUESTION_TAIL_EXCLUDE, SHORT_FUNCTION_WORD, pauseBreakPriority,
} from './segmenterData';

/** 输入词(TranscriptWord 结构兼容;无时间戳时停顿断点不参与)。 */
export interface SegmentWord {
  text: string;
  start?: number; // ms
  end?: number; // ms
}

export interface SegmentOpts {
  /** 字符单位预算(CJK=2/其余=1,见文件头注释)。不给则只按词数分页。 */
  maxCharsPerLine?: number;
  /** 每页词数预算(标点词不计)。CJK 主导文本且给了 maxCharsPerLine 时忽略。 */
  wordsPerPage: number;
}

interface BreakPoint {
  wordIndex: number; // 断点在该词之后
  priority: number;
  orphanRisk: boolean;
}

const CJK_START = /[㐀-鿿぀-ヿ가-힯]/u;
const PUNCT_ONLY = /^[\p{P}]+$/u;
const CJK_PUNCT_CHARS = /[，。！？；：、“”‘’（）【】《》「」『』〈〉〔〕｛｝〖〗…—～·]|[｡､]/;
const LATIN_PUNCT_CHARS = /[.,!?;:'"()[\]{}/\\@#$%^&*\-+=<>|~`]/;

type WordScript = 'punctuation' | 'number' | 'cjk' | 'latin' | 'mixed';

/** 字符分类:0=CJK 1=小写拉丁 2=大写拉丁 3=数字 4=标点 5=空格 6=其他。 */
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
  return 6; // ponytail: 代理对不再细分,一律按其他计
}

function hasCjkChar(text: string): boolean {
  for (const ch of text) if (charClass(ch) === 0) return true;
  return false;
}

function isPunctOnly(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && PUNCT_ONLY.test(t);
}

/** 词的文种分类。 */
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

/** 两词之间的接缝文本。 */
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

/** CJK 占比 ≥0.3 判为 CJK 主导。 */
export function isCjkDominant(text: string): boolean {
  let cjk = 0, letters = 0;
  for (const ch of text) {
    const cls = charClass(ch);
    if (cls === 0) { cjk++; letters++; } else if (cls === 1 || cls === 2 || cls === 3) letters++;
  }
  return letters > 0 && cjk / letters >= 0.3;
}

interface LatinBreak { isOrphanRisk: boolean; position: number; score: number }

/** 英文断点打分器:遍历相邻词对,基础 20 分,
 * LATIN_BREAK_PATTERNS 命中改分、LATIN_PENALTY_PATTERNS 首个命中扣罚、句末 /[.!?]$/ +30、SHORT_FUNCTION_WORD 孤词且剩词 ≤2 时 −40。 */
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

/** CJK 标点断点优先级:句末 100 / 逗顿 80 / 引号收 70。 */
function cjkPunctPriority(text: string): number | null {
  const last = text[text.length - 1];
  if ((CJK_PUNCT.sentenceEnd as readonly string[]).includes(last)) return 100;
  if ((CJK_PUNCT.clauseBreak as readonly string[]).includes(last)) return 80;
  if ((CJK_PUNCT.quoteEnd as readonly string[]).includes(last)) return 70;
  return null;
}

/** 语气词后断:左词末字 ∈ MODAL_PARTICLES 且右词以 CJK 开头。 */
function isModalBreak(left: string, right: string): boolean {
  const tail = left.trim().at(-1);
  const head = right.trim().at(0);
  if (!tail || !head) return false;
  return (MODAL_PARTICLES as readonly string[]).includes(tail) && CJK_START.test(head);
}

/** CJK 孤词避断:左词末字或右词首字 ∈ CJK_PARTICLES → orphanRisk。 */
function isCjkOrphanPair(left: string, right: string): boolean {
  return (CJK_PARTICLES as readonly string[]).includes(left[left.length - 1])
    || (CJK_PARTICLES as readonly string[]).includes(right[0]);
}

function normalizeLatin(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** 英文孤词风险种类。 */
function hasLatinOrphanRisk(left: string, right: string): boolean {
  if (normalizeLatin(right) === 'of'
    && (LATIN_QUANTIFIERS as readonly string[]).includes(normalizeLatin(left))) return true; // LATIN_QUANTIFIERS
  return (LATIN_FUNCTION_WORDS as readonly string[]).includes(normalizeLatin(left));
}

/** 连接词带逗号时 150–400ms 小停顿不算断点。 */
function isPauseSuppressedPair(left: string, right: string): boolean {
  if (!(PAUSE_SUPPRESSED_CONNECTORS as readonly string[]).includes(normalizeLatin(left))
    || !/[,;:][\s"'”’）)\]}》」』】]*$/u.test(left.trim())) return false;
  return normalizeLatin(right).length > 0;
}

/** CJK 疑问句式断点:
 * 「…有什么/是不是谁…」后接人称/时序词 → 优先级 58。 */
function isQuestionBreak(words: SegmentWord[], idx: number): boolean {
  const cjkOnly = (from: number, to: number): string =>
    Array.from(words.slice(from, to).map((w) => w.text).join('')).filter((ch) => charClass(ch) === 0).join('');
  const tail = cjkOnly(0, idx + 1).slice(-12);
  const head = cjkOnly(idx + 1, Math.min(words.length, idx + 5)).slice(0, 6);
  if (!tail || !head || QUESTION_TAIL_EXCLUDE.test(tail) || !QUESTION_TAIL.test(tail)) return false;
  return QUESTION_HEAD.test(head);
}

/** 「idx−1 与 idx 之间不可拆」:
 * 无接缝且 Intl.Segmenter 判定落在同一 CJK 词内(或命中 CJK_WORD_SUFFIXES 词缀)。整段文本只分词一次。 */
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

/** 英文相邻词对断点:±2 词窗口跑 scoreLatinBreaks,取离断点最近
 * (<10 字符)的打分;否则兜底 40 分 safe。 */
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

/** 断点候选收集。 */
function collectBreakPoints(words: SegmentWord[], scripts: WordScript[], cannotSplit: (i: number) => boolean): BreakPoint[] {
  const bps: BreakPoint[] = [];
  for (let r = 0; r < words.length - 1; r++) {
    const left = words[r];
    const right = words[r + 1];
    if (isPunctOnly(right.text)) continue; // 标点词永不开行
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

/** 选最优断点:有效分 = priority − 孤词降权 30,
 * 同分取靠后;不可拆处剔除。 */
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

/** 字符单位:CJK=2,其余每字符 1(见文件头偏差说明 1)。 */
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

/** 行首助词回拉:某页首词以 NO_LINE_START
 * 助词开头时,从上一页尾部找可拆位把词拉入本页(两页都得仍在预算内)。 */
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

/** 内容感知分段:返回每页起始词下标(首页恒为 0)。
 * 预算触顶(词数或字符单位)时在当前页窗口内选分数最高的断点回退断行;
 * 标点词永不开页;粘着 CJK 词(Intl.Segmenter 同词)不硬拆。 */
export function segmentWords(words: SegmentWord[], opts: SegmentOpts): number[] {
  if (words.length === 0) return [];
  const scripts = words.map((w) => wordScript(w.text));
  const cannotSplit = makeCannotSplit(words, scripts);
  const bps = collectBreakPoints(words, scripts, cannotSplit);
  const maxUnits = opts.maxCharsPerLine;
  // CJK 主导且 wordsPerPage>1 时词数预算置空
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
        units = nextUnits; // 粘着词无法拆,容忍超预算
        count = nextCount;
      }
    } else {
      units = nextUnits;
      count = nextCount;
    }
  }
  return pullParticleForward(words, scripts, starts, cannotSplit, maxUnits, wordsPerPage);
}
