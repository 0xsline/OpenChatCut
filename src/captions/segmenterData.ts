// 内容感知字幕分段——词表/权重常量(不许改动)。

/** 英文断点模式表:左词命中 → 该词后是好断点。 */
export const LATIN_BREAK_PATTERNS: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /[.!?:;,]$/, score: 100 },
];

/** 英文避断惩罚对(12 条,顺序敏感——首个命中即停)。
 * 对「左词 右词」整体匹配,命中则从断点分扣掉 penalty。 */
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

/** 英文短功能词:孤词风险——scoreLatinBreaks 里当下一词命中且剩词 ≤2 时 −40。 */
export const SHORT_FUNCTION_WORD =
  /^(a|an|the|of|in|on|at|by|to|for|with|and|but|or|if|as|is|are|was|were|be|been|have|has|had|do|does|did|will|would|could|should|might|may|must|can|shall)$/i;

/** 中文标点分类。 */
export const CJK_PUNCT = {
  clauseBreak: ['，', '；', '：', '、', '､'],
  quoteEnd: ['”', '’', '）', '】', '》', '」', '』', '〉'],
  sentenceEnd: ['。', '！', '？', '…', '．', '｡'],
} as const;

/** 语气词:位于左词末尾且右词以 CJK 开头 → 好断点(其后断,优先级 60)。 */
export const MODAL_PARTICLES = ['啊', '吧', '呗', '哈', '啦', '嘛', '呢', '哦', '呀'] as const;

/** 结构助词/粘着词表(含日/韩助词):
 * 孤词避断——左词末字或右词首字命中 → 该断点标记 orphanRisk(选断点时降权 30)。 */
export const CJK_PARTICLES = [
  '的', '地', '得', '了', '着', '过', '是', '在', '有', '和', '与', '或', '及', '并', '但', '而', '却',
  '因', '为', '由', '若', '如', '虽', '然', '则', '即', '便', '把', '被', '让', '给', '对', '向', '从',
  '到', '于', '按', '依', '据', '以', '吗', '呢', '吧', '啊', '呀', '哦', '哇', '嘛', '呐', '这', '那',
  '些', '个', '位', '一', '二', '三', '几', '多', '少',
  'は', 'が', 'を', 'に', 'で', 'と', 'の', 'へ', 'も', 'や',
  '은', '는', '이', '가', '을', '를', '에', '의', '도', '만',
] as const;

/** 不可作行首的助词:行首助词回拉——若某页以这些字开头,
 * 从上一页拉词并入本页。 */
export const NO_LINE_START = [
  '的', '地', '得', '了', '着', '过', '个', '些', '们', '吗', '呢', '吧', '啊', '呀', '哦', '哇', '嘛',
  '呐', '下',
  'は', 'が', 'を', 'に', 'で', 'と', 'の', 'へ', 'も', 'や',
  '은', '는', '이', '가', '을', '를', '에', '의', '도', '만',
] as const;

/** 英文功能词:判 latinFunction 孤词风险用。 */
export const LATIN_FUNCTION_WORDS = [
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'by', 'to', 'for', 'with', 'and', 'but', 'or', 'if', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'might', 'may', 'must', 'can', 'shall',
] as const;

/** 量词表:「X of」不拆(latinQuantifierOf 孤词风险)。 */
export const LATIN_QUANTIFIERS = [
  'bit', 'bits', 'bunch', 'couple', 'couples', 'group', 'groups', 'kind', 'kinds', 'lot', 'lots',
  'number', 'numbers', 'part', 'parts', 'piece', 'pieces', 'range', 'ranges', 'series', 'set', 'sets',
  'sort', 'sorts', 'type', 'types', 'varieties', 'variety',
] as const;

/** 停顿降噪连接词:这些词带逗号结尾时,
 * 150–400ms 的小停顿不算断点(≥400ms 才算)。 */
export const PAUSE_SUPPRESSED_CONNECTORS = [
  'a', 'an', 'and', 'but', 'he', 'i', 'it', 'or', 'she', 'so', 'that', 'the', 'these', 'they', 'this',
  'those', 'we', 'you',
] as const;

/** CJK 词缀:分词兜底——左字为 CJK 且右字命中 → 不可拆。 */
export const CJK_WORD_SUFFIXES = ['们', '化', '性', '者', '度', '流', '栈', '后'] as const;

/** CJK 疑问句式(两条正则,优先级 58 断点)。 */
export const QUESTION_TAIL = /(?:有|没有|还有|是|是不是|叫|做|干|看到|看见|找到)(?:什么|啥|谁|哪里|哪儿)$/u;
export const QUESTION_TAIL_EXCLUDE = /(?:为|凭)什么$/u;
export const QUESTION_HEAD = /^(?:我|你|您|他|她|它|这|那|咱|我们|你们|他们|她们|现在|然后|接着|对了)/u;

/** 停顿断点优先级:间隔 ms → priority。 */
export function pauseBreakPriority(gapMs: number): number {
  if (gapMs >= 400) return 90;
  if (gapMs >= 250) return 70;
  return 55;
}

/** 选断点时孤词风险降权。 */
export const ORPHAN_PICK_DEMOTION = 30;

/** 停顿成为断点的最小间隔与降噪阈值。 */
export const PAUSE_MIN_MS = 150;
export const PAUSE_SUPPRESSED_MIN_MS = 400;
