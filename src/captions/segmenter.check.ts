// 内容感知分段引擎断言:①中文标点优先断 ②语气词不落行首 ③「的」不拆
// ④孤词惩罚 ⑤英文句末优先断 ⑥无 opts 时 paginate 与旧版逐字节一致(回归)。
// 期望值均按 segmenter.ts 规则手推;跑法:npx tsx src/captions/segmenter.check.ts
import assert from 'node:assert/strict';
import { scoreLatinBreaks, segmentWords } from './segmenter';
import type { CaptionPage } from './types';
import { paginate } from './types';
import type { TranscriptWord } from '../transcript/types';

const S = (texts: string[]) => texts.map((text) => ({ text }));
const W = (texts: string[], gapMs = 10, durMs = 90): TranscriptWord[] =>
  texts.map((text, i) => ({ text, start: i * (durMs + gapMs), end: i * (durMs + gapMs) + durMs }));
const pageTexts = (pages: CaptionPage[]) => pages.map((p) => p.words.map((w) => w.text).join(''));

// ── ① 中文句号/逗号处优先断(oHe: 。→100 / ，→80 抢过预算触顶位) ──────────────
{
  const words = S(['今天', '天气', '真好。', '我们', '一起', '去', '公园']);
  // 字符预算在「一起」处触顶,回退选句号断点 → 断在 真好。 之后
  assert.deepEqual(segmentWords(words, { wordsPerPage: 50, maxCharsPerLine: 20 }), [0, 3]);

  const comma = S(['我说，', '大家', '都', '要', '来', '我家', '吃饭']);
  assert.deepEqual(segmentWords(comma, { wordsPerPage: 50, maxCharsPerLine: 20 }), [0, 1]);
}

// ── ② 语气词「呢/吗/啊」不落行首 ─────────────────────────────────────────────
{
  // 呢:aHe 语气词断点(60)让页在「呢」后断,而非预算触顶处
  const ne = S(['你', '在', '想', '什么', '呢', '明天', '我们', '出发']);
  const starts = segmentWords(ne, { wordsPerPage: 50, maxCharsPerLine: 20 });
  assert.deepEqual(starts, [0, 5]); // 页2 从「明天」起,「呢」收在页1 末尾
  // 吗:mA 孤词降权(吗/了 ∈ Q9)让相邻断点全部落选
  const ma = S(['你', '吃', '了', '吗', '我们', '走']);
  const maStarts = segmentWords(ma, { wordsPerPage: 50, maxCharsPerLine: 8 });
  assert.ok(!maStarts.includes(2) && !maStarts.includes(3), '「了」「吗」不得为页首');
  for (const st of maStarts) assert.ok(!['了', '吗', '呢', '啊'].includes(Array.from(ma[st].text)[0]), '语气词页首');
  for (const st of starts) assert.ok(!['了', '吗', '呢', '啊'].includes(Array.from(ne[st].text)[0]), '语气词页首');
  // FHe 行首助词回拉:页2 首词「了解」以 G9e 字「了」开头 → 把上一页尾词 fine 拉入本页
  const pull = S(['OK', 'fine', '了解', '一下', '吧']);
  assert.deepEqual(segmentWords(pull, { wordsPerPage: 50, maxCharsPerLine: 15 }), [0, 1]);
}

// ── ③ 结构助词「的」不与前词分离(mA: 的 ∈ Q9 → 两侧断点均降权 30) ──────────
{
  const words = S(['我', '买', '的', '苹果', '很', '好吃', '非常', '新鲜']);
  const starts = segmentWords(words, { wordsPerPage: 50, maxCharsPerLine: 10 });
  assert.deepEqual(starts, [0, 4, 7]);
  assert.ok(!starts.includes(2), '「的」不得为页首(买|的 不拆)');
  assert.ok(!starts.includes(3), '「的」不得悬在页尾(的|苹果 不拆)');
}

// ── ④ 孤词惩罚:结尾不留 1-2 个功能词孤行(U9e quantifier-of/trailing + cP 降权) ──
{
  const words = S(['We', 'learned', 'quite', 'a', 'lot', 'of', 'things', 'today']);
  const starts = segmentWords(words, { wordsPerPage: 50, maxCharsPerLine: 30 });
  // 触顶在 things;a/lot/of 侧断点全带孤词风险 → 回退断在 quite 之后
  assert.deepEqual(starts, [0, 3]);
  const pages = [words.slice(0, 3), words.slice(3)].map((ws) => ws.map((w) => w.text));
  assert.equal(pages[0].join(' '), 'We learned quite');
  assert.equal(pages[1].join(' '), 'a lot of things today');
  for (let i = 0; i < starts.length; i++) {
    const end = (starts[i + 1] ?? words.length) - 1;
    assert.notEqual(words[end].text, 'of', '页尾不得悬空 of');
  }
}

// ── ⑤ 纯英文句末 . 优先断(z9e 100 + 句末 +30 = 130) ─────────────────────────
{
  const words = S(['I', 'like', 'it.', 'Because', 'it', 'works', 'well', 'today']);
  assert.deepEqual(segmentWords(words, { wordsPerPage: 50, maxCharsPerLine: 30 }), [0, 3]);
  // 词数预算触顶同样走打分回退(任务规格,见 segmenter.ts 头注偏差 2)
  assert.deepEqual(segmentWords(S(['I', 'like', 'it.', 'Because', 'it', 'works']), { wordsPerPage: 4 }), [0, 3]);
  // H9e 打分器本体:句末词得 100+30
  const top = scoreLatinBreaks('We had fun. So it goes')[0];
  assert.equal(top.score, 130);
  assert.equal(top.position, 'We had fun.'.length);
}

// ── 杂项语义:标点词不开页 / M1e CJK 忽略词数预算 / 边界 ───────────────────────
{
  const starts = segmentWords(S(['Hello', 'world', '!', 'again', 'now', 'yes', 'more']), { wordsPerPage: 2 });
  assert.deepEqual(starts, [0, 3, 5]); // 「!」跟随 world 收在页1,不开页
  // M1e 语义:CJK 主导 + 给了字符预算 → wordsPerPage 置空
  assert.deepEqual(segmentWords(S(['一二', '三四', '五六', '七八']), { wordsPerPage: 2, maxCharsPerLine: 100 }), [0]);
  assert.deepEqual(segmentWords(S(['aa', 'bb', 'cc', 'dd']), { wordsPerPage: 2, maxCharsPerLine: 100 }), [0, 2]);
  assert.deepEqual(segmentWords([], { wordsPerPage: 6 }), []);
  assert.deepEqual(segmentWords(S(['hi']), { wordsPerPage: 1, maxCharsPerLine: 1 }), [0]);
}

// ── paginate 接入:maxCharsPerLine 走 segmenter;forceBreak 仍最高优先 ──────────
{
  const cn = W(['今天', '天气', '真好。', '我们', '一起', '去', '公园']);
  assert.deepEqual(pageTexts(paginate(cn, 'phrase', 50, undefined, 20)), ['今天天气真好。', '我们一起去公园']);
  const forced = paginate(cn, 'phrase', 50, new Set([5]), 20);
  assert.deepEqual(pageTexts(forced), ['今天天气真好。', '我们一起', '去公园']);
  assert.equal(forced[2].words[0].text, '去'); // 强制断点处必开新页
  // word pacing 不受 maxCharsPerLine 影响
  assert.equal(paginate(cn, 'word', 6, undefined, 20).length, cn.length);
}

// ── ⑥ 回归:无 maxCharsPerLine 时 paginate 行为与旧版一致 ────────────────────
{
  // 6 词满页 flush
  const plain = W(['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh']);
  assert.deepEqual(paginate(plain, 'phrase').map((p) => p.words.length), [6, 2]);
  // 句末标点 flush
  assert.deepEqual(paginate(W(['Hi', 'there.', 'Big', 'day']), 'phrase').map((p) => p.words.length), [2, 2]);
  // >700ms 停顿 flush
  const gap: TranscriptWord[] = [
    { text: 'a', start: 0, end: 100 }, { text: 'b', start: 110, end: 200 },
    { text: 'c', start: 1000, end: 1100 }, { text: 'd', start: 1110, end: 1200 },
  ];
  assert.deepEqual(paginate(gap, 'phrase').map((p) => p.words.length), [2, 2]);
  // forceBreak
  assert.deepEqual(paginate(W(['aa', 'bb', 'cc', 'dd']), 'phrase', 6, new Set([2])).map((p) => p.words.length), [2, 2]);
  // 页面时间戳字段
  const pages = paginate(plain, 'phrase');
  assert.equal(pages[0].start, plain[0].start);
  assert.equal(pages[0].end, plain[5].end);
  assert.equal(pages[1].start, plain[6].start);
}

console.log('segmenter.check: ok');
