// Content-aware subtitle segmentation - vocabulary/weight constants (no changes allowed).

/** English breakpoint mode table:left word hit → This word is followed by a good break point. */
export const LATIN_BREAK_PATTERNS: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /[.!?:;,]$/, score: 100 },
];

/** avoid punishment in english(12 Article,Sequence sensitive - stop on first hit)。
 * Match "left word right word" as a whole,Hits will be deducted from breakpoint points. penalty。 */
export const LATIN_PENALTY_PATTERNS: ReadonlyArray<{ pattern: RegExp; penalty: number }> = [
  { pattern: /^(a|an|the|i|we|you|he|she|it|they|this|that|these|those|and|but|or|so)[,;:]\s+\w+$/i, penalty: 95 },
  { pattern: /^(lot|lots|kind|kinds|sort|sorts|type|types|part|parts|number|numbers|couple|couples|bit|bits|piece|pieces|group|groups|bunch|series|set|sets|range|ranges|variety|varieties)\s+of$/i, penalty: 95 },
  { pattern: /^(and|but|or|so|yet|nor|for|however|although|because|since|while|whereas|who|which|that|where|when|why|whose|in|on|at|by|with|from|to|of|about|through|during|before|after|above|below|between|among|under|over|without|within|beyond|across|against|around|behind|beside|beneath|inside|outside|towards|throughout|upon|the|a|an)\s+\w+$/i, penalty: 90 },
  { pattern: /^(the|a|an|this|that|these|those)\s+\w+$/i, penalty: 60 },
  { pattern: /\w+(ed|ing|ly|er|est|ful|less|ous|ive|able|ible)\s+\w+$/i, penalty: 55 },
  { pattern: /^[A-Z][a-z]+\s+[A-Z][a-z]+$/, penalty: 70 },
  { pattern: /^(Dr|Mr|Mrs|Ms|Prof|President|Director|Professor|Minister|Secretary|Ambassador)\s+[A-Z][a-z]+$/i, penalty: 75 },
  { pattern: /^\w+\s+(up|down|in|out|on|off|over|under|through|around|across|along|away|back|forward|ahead|behind|beside|between|among|above|below|inside|outside|onto|into|upon|within|without|throughout|against|towards|beyond|beneath|underneath|alongside)$/i, penalty: 80 },
  { pattern: /^(I|you|he|she|it|we|they|this|that)\s+\w+$/i, penalty: 65 },
  { pattern: /^(can|will|would|could|should|might|may|must|have|has|had|do|does|did|am|is|are|was|were|being|been)\s+\w+$/i, penalty: 70 },
  { pattern: /^(not|never|no|nothing|nobody|nowhere|neither|none|hardly|scarcely|barely|seldom|rarely)\s+\w+$/i, penalty: 75 },
  { pattern: /^\d+\s+(years?|months?|weeks?|days?|hours?|minutes?|seconds?|miles?|kilometers?|feet|inches?|pounds?|kilograms?|degrees?|percent)$/i, penalty: 80 },
];

/** English short function words:Orphan word risk——scoreLatinBreaks The word "in the moment" hits and the remaining words are ≤2 time −40。 */
export const SHORT_FUNCTION_WORD =
  /^(a|an|the|of|in|on|at|by|to|for|with|and|but|or|if|as|is|are|was|were|be|been|have|has|had|do|does|did|will|would|could|should|might|may|must|can|shall)$/i;

/** Chinese punctuation classification. */
export const CJK_PUNCT = {
  clauseBreak: ['，', '；', '：', '、', '､'],
  quoteEnd: ['”', '’', '）', '】', '》', '」', '』', '〉'],
  sentenceEnd: ['。', '！', '？', '…', '．', '｡'],
} as const;

/** modal particles:At the end of the left word and the right word starts with CJK Beginning → Good breakpoint(Then cut off,priority 60)。 */
export const MODAL_PARTICLES = ['Ah', 'Bar', 'Okay', 'Ha', 'La', 'Well', 'yet', 'Oh', 'Yeah'] as const;

/** structural particle/Sticky word list(Including days/Korean particle):
 * Avoid breaking off isolated words - hit the last word of the left word or the first word of the right word → The breakpoint mark orphanRisk(Reduce power when selecting a breakpoint 30)。 */
export const CJK_PARTICLES = [
  'of', 'land', 'Got', 'Got it', 'With', 'passed', 'Yes', 'in', 'Yes', 'and', 'with', 'or', 'and', 'and', 'But', 'And', 'But',
  'Because', 'for', 'by', 'If', 'Such as', 'Although', 'Ran', 'rule', 'That is', 'convenient', 'put', 'Be', 'let', 'give', 'Yes', 'towards', 'from',
  'Arrive', 'at', 'press', 'According to', 'According to', 'to', '?', 'yet', 'Bar', 'Ah', 'Yeah', 'Oh', 'wow', 'Well', 'Na', 'this', 'That',
  'some', 'a', 'Bit', 'one', 'Two', 'three', 'How many', 'Much', 'less',
  'は', 'が', 'を', 'に', 'で', 'と', 'の', 'へ', 'も', 'や',
  '은', '는', '이', '가', '을', '를', '에', '의', '도', '만',
] as const;

/** Particles that cannot be used as the beginning of a line:Pull back the starting particles of the line - if a page begins with these words,
 * Pull words from the previous page and merge them into this page. */
export const NO_LINE_START = [
  'of', 'land', 'Got', 'Got it', 'With', 'passed', 'a', 'some', 'them', '?', 'yet', 'Bar', 'Ah', 'Yeah', 'Oh', 'wow', 'Well',
  'Na', 'down',
  'は', 'が', 'を', 'に', 'で', 'と', 'の', 'へ', 'も', 'や',
  '은', '는', '이', '가', '을', '를', '에', '의', '도', '만',
] as const;

/** English function words:judge latinFunction Lone words are risky to use. */
export const LATIN_FUNCTION_WORDS = [
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'by', 'to', 'for', 'with', 'and', 'but', 'or', 'if', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'might', 'may', 'must', 'can', 'shall',
] as const;

/** Quantifier list:「X of"Don't dismantle(latinQuantifierOf Orphan word risk)。 */
export const LATIN_QUANTIFIERS = [
  'bit', 'bits', 'bunch', 'couple', 'couples', 'group', 'groups', 'kind', 'kinds', 'lot', 'lots',
  'number', 'numbers', 'part', 'parts', 'piece', 'pieces', 'range', 'ranges', 'series', 'set', 'sets',
  'sort', 'sorts', 'type', 'types', 'varieties', 'variety',
] as const;

/** pause noise reduction connectives:When these words end with a comma,
 * 150–400ms The small pause does not count as a breakpoint(≥400ms That’s it)。 */
export const PAUSE_SUPPRESSED_CONNECTORS = [
  'a', 'an', 'and', 'but', 'he', 'i', 'it', 'or', 'she', 'so', 'that', 'the', 'these', 'they', 'this',
  'those', 'we', 'you',
] as const;

/** CJK affix:The word participle is all about - the word "left" is CJK And the right word hits → Not removable. */
export const CJK_WORD_SUFFIXES = ['them', 'ization', 'sex', 'who', 'Degree', 'flow', 'stack', 'after'] as const;

/** CJK interrogative sentence(two rules,priority 58 breakpoint)。 */
export const QUESTION_TAIL = /(?:Yes|No|Also|Yes|Isn't it|call|do|dry|see|see|found)(?:what|What|who|where|where)$/u;
export const QUESTION_TAIL_EXCLUDE = /(?:for|By)what$/u;
export const QUESTION_HEAD = /^(?:me|you|you|him|her|it|this|That|We|us|you|them|them|Now|then|Then|Right)/u;

/** Pause breakpoint priority:interval ms → priority。 */
export function pauseBreakPriority(gapMs: number): number {
  if (gapMs >= 400) return 90;
  if (gapMs >= 250) return 70;
  return 55;
}

/** When selecting a breakpoint, the risk of orphan words is reduced. */
export const ORPHAN_PICK_DEMOTION = 30;

/** The minimum interval and noise reduction threshold for a pause to become a breakpoint. */
export const PAUSE_MIN_MS = 150;
export const PAUSE_SUPPRESSED_MIN_MS = 400;
