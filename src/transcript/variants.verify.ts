// Runnable contract check: `npx tsx src/transcript/variants.check.ts`.
// 聚焦多语言转写变体与词帧双向一致:变体只承载文本,时间戳恒取源。
import assert from 'node:assert';
import type { TranscriptWord, TranscriptVariant } from './types';
import { resolveVariantText, createVariant, upsertVariant, findVariantByLang } from './variants';
import { retimeWords } from './edit';
import { makeDraft } from '../editor/store';
import type { TimelineState } from '../editor/types';
import { docFromTimeline } from '../persist/projectStore';

const source: TranscriptWord[] = [
  { text: '你好', start: 0, end: 200, speaker: 'A' },
  { text: '世界', start: 200, end: 500, speaker: 'A' },
  { text: '再见', start: 500, end: 900, speaker: 'B' },
];

// ── 1) resolveVariantText:只换 text,start/end/speaker 恒取源;缺项返回源词引用 ──
const variant: TranscriptVariant = {
  id: 'v1', lang: 'English', kind: 'translation', label: 'English',
  words: [
    { i: 0, text: 'hello' },
    { i: 2, text: 'bye' },
    { i: 99, text: 'OUT_OF_RANGE' }, // 越界:必须被安全忽略,不得触碰任何词
  ],
};
const out = resolveVariantText(source, variant);
assert.strictEqual(out.length, source.length, 'variant never changes word count');
assert.strictEqual(out[0].text, 'hello', 'i=0 text swapped');
assert.strictEqual(out[1].text, '世界', 'no entry for i=1 → source text');
assert.strictEqual(out[2].text, 'bye', 'i=2 text swapped');
// 每个词的 start/end/speaker 恒等于源词。
for (let i = 0; i < source.length; i++) {
  assert.strictEqual(out[i].start, source[i].start, `word ${i} start from source`);
  assert.strictEqual(out[i].end, source[i].end, `word ${i} end from source`);
  assert.strictEqual(out[i].speaker, source[i].speaker, `word ${i} speaker from source`);
}
// 越界项无副作用:未映射的 i=1 返回的正是同一个源词引用(零拷贝、零篡改)
assert.ok(Object.is(out[1], source[1]), 'untouched word keeps the source reference');

// ── 2) 空变体 = 源词数组本身(字节等同,向后兼容) ──
const empty: TranscriptVariant = { id: 'e', lang: 'x', kind: 'corrected', label: 'x', words: [] };
assert.ok(Object.is(resolveVariantText(source, empty), source), 'empty variant is a no-op (same array reference)');

// ── 3) 套用变体后 retime 的时间轴与源词 retime 完全一致 ────────────────
// (翻译只改文本,不得因此重排或移动任何词的帧位)
const fps = 30;
const timedSource = retimeWords(source, new Set(), fps, 0);
const timedVariant = retimeWords(out, new Set(), fps, 0);
assert.strictEqual(timedVariant.length, timedSource.length, 'retime keeps the same word count');
for (let i = 0; i < timedSource.length; i++) {
  assert.strictEqual(timedVariant[i].start, timedSource[i].start, `retimed start ${i} unaffected by variant text`);
  assert.strictEqual(timedVariant[i].end, timedSource[i].end, `retimed end ${i} unaffected by variant text`);
}
// 文本确实随变体走(译文进了字幕流)
assert.strictEqual(timedVariant[0].text, 'hello');
assert.strictEqual(timedVariant[2].text, 'bye');

// ── 4) createVariant:边界校验丢弃坏词条(LLM 输出不可信) ──
const built = createVariant({
  lang: '  日本語  ', kind: 'translation',
  words: [
    { i: 0, text: 'こんにちは' },
    { i: -1, text: 'bad-index' },      // 负下标 → 丢弃
    { i: 1.5, text: 'bad-float' },     // 非整数 → 丢弃
    { i: 2, text: 3 as unknown as string }, // 非字符串 → 丢弃
  ],
});
assert.strictEqual(built.lang, '日本語', 'lang trimmed');
assert.strictEqual(built.label, '日本語', 'translation label defaults to lang');
assert.deepStrictEqual(built.words, [{ i: 0, text: 'こんにちは' }], 'only the valid word entry survives');
assert.ok(built.id.startsWith('var_'), 'variant gets an id');
assert.throws(() => createVariant({ lang: '   ', kind: 'translation', words: [] }), /lang is required/);

// ── 5) upsertVariant / findVariantByLang:不可变增改 + 按语言查找 ──
const list0: TranscriptVariant[] = [];
const list1 = upsertVariant(list0, built);
assert.strictEqual(list0.length, 0, 'upsert does not mutate the input list');
assert.strictEqual(list1.length, 1);
const replaced = createVariant({ id: built.id, lang: '日本語', kind: 'translation', words: [{ i: 0, text: 'やあ' }] });
const list2 = upsertVariant(list1, replaced);
assert.strictEqual(list2.length, 1, 'same id replaces in place');
assert.strictEqual(list2[0].words[0].text, 'やあ');
assert.strictEqual(findVariantByLang(list2, '日本語', 'translation')?.id, built.id);
assert.strictEqual(findVariantByLang(list2, 'nope'), undefined);

// ── 6) 存储往返:setItemVariants 落盘,transcript/timing/时长全不动 ──
const state: TimelineState = {
  fps, width: 1920, height: 1080, selectedId: null,
  items: [{ id: 'clip', track: 'A1', startFrame: 0, durationInFrames: 24, name: 'vo', kind: 'audio', src: '/vo.mp3', transcript: source }],
};
const draft = makeDraft(docFromTimeline(state));
draft.commands.setItemVariants('clip', [variant]);
const item = draft.getState().items.find((it) => it.id === 'clip')!;
assert.strictEqual(item.variants?.length, 1, 'variant persisted on the item');
assert.strictEqual(item.variants![0].id, 'v1');
assert.deepStrictEqual(item.transcript, source, 'transcript words untouched by setItemVariants');
assert.strictEqual(item.durationInFrames, 24, 'clip duration untouched');

console.log('variants.check: ok');
