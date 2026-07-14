// Runnable source-contract check: `npx tsx src/agent/captions-tools.check.ts`.
// 覆盖三层:① paginate/applyWordOverrides 的纯逻辑(隐藏/换文本/强制换页/无覆盖时字节级不变);
// ② execCaptionsTool 经 makeDraft 落到 updateCaptions,read_captions 能读回覆盖状态;
// ③ 字幕多源合并(sources[]/sourceMode:'timeline')——resolveCaptionWords 按绝对时间排序合并 +
// 单源路径字节级不变 + set_caption_sources 工具。
import assert from 'node:assert/strict';
import { paginate } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import { applyWordOverrides, resolveCaptionWords, resolveCaptionWordIndices } from '../captions/resolve';
import { makeDraft } from '../editor/store';
import type { TimelineState } from '../editor/types';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';
import { execCaptionsTool } from './captions-tools';

// ── 1) 纯逻辑:applyWordOverrides + paginate ─────────────────────────────
const words: TranscriptWord[] = [
  { text: 'hello', start: 0, end: 100 },
  { text: 'brave', start: 100, end: 200 },
  { text: 'new', start: 200, end: 300 },
  { text: 'world', start: 300, end: 400 },
  { text: 'today', start: 400, end: 500 },
];
const indices = [0, 1, 2, 3, 4];

// 无覆盖:原样透传(同一引用),分页输出与"没有这套逻辑之前"字节级一致
{
  const { words: out, breakBefore } = applyWordOverrides(words, indices, undefined);
  assert.equal(out, words, 'no overrides → same words reference (no-op)');
  assert.equal(breakBefore.size, 0);
  assert.deepEqual(paginate(words, 'phrase', 6, breakBefore), paginate(words, 'phrase', 6), 'breakBefore=empty set behaves like no 4th arg');
}

// hidden:词从输出里消失
{
  const { words: out } = applyWordOverrides(words, indices, { 1: { hidden: true } });
  assert.deepEqual(out.map((w) => w.text), ['hello', 'new', 'world', 'today'], 'hidden word dropped');
}

// text:替换显示文本,timing 不变
{
  const { words: out } = applyWordOverrides(words, indices, { 2: { text: 'BRAND-NEW' } });
  assert.equal(out[2].text, 'BRAND-NEW');
  assert.equal(out[2].start, 200, 'start untouched by text override');
  assert.equal(out[2].end, 300, 'end untouched by text override');
}

// forceBreak:在该词前另起一页
{
  const { words: out, breakBefore } = applyWordOverrides(words, indices, { 3: { forceBreak: true } });
  const pages = paginate(out, 'phrase', 10, breakBefore);
  assert.equal(pages.length, 2, 'forceBreak splits into two pages');
  assert.deepEqual(pages[0].words.map((w) => w.text), ['hello', 'brave', 'new']);
  assert.deepEqual(pages[1].words.map((w) => w.text), ['world', 'today']);
}

// 三者组合:隐藏 + 换文本 + 强制换页 一起生效
{
  const { words: out, breakBefore } = applyWordOverrides(words, indices, {
    1: { hidden: true },
    2: { text: 'BRAND-NEW' },
    3: { forceBreak: true },
  });
  assert.deepEqual(out.map((w) => w.text), ['hello', 'BRAND-NEW', 'world', 'today']);
  const pages = paginate(out, 'phrase', 10, breakBefore);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].words.map((w) => w.text), ['hello', 'BRAND-NEW']);
  assert.deepEqual(pages[1].words.map((w) => w.text), ['world', 'today']);
}

console.log('captions-tools.check: pure logic ok');

// ── 2) execCaptionsTool 经 makeDraft/updateCaptions 落地 ────────────────
const transcript: TranscriptWord[] = [
  { text: 'hello', start: 0, end: 100 },
  { text: 'brave', start: 100, end: 200 },
  { text: 'new', start: 200, end: 300 },
  { text: 'world', start: 300, end: 400 },
];
const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [{ id: 'clip', track: 'A1', startFrame: 0, durationInFrames: 120, name: 'vo', kind: 'audio', src: '/vo.mp3', transcript }],
  captions: { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: 'clip' },
};
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// read_captions:未加覆盖时,四个词原样可读,override 都是 null
const r0 = await execCaptionsTool('read_captions', {}, ctx) as { enabled: boolean; pages: { words: { index: number; text: string; override: unknown }[] }[] };
assert.equal(r0.enabled, true);
const flat0 = r0.pages.flatMap((p) => p.words);
assert.deepEqual(flat0.map((w) => w.text), ['hello', 'brave', 'new', 'world']);
assert.deepEqual(flat0.map((w) => w.index), [0, 1, 2, 3]);
assert.ok(flat0.every((w) => w.override === null));

// edit_caption_words:隐藏 idx1,替换 idx2 文本,idx3 强制换页
const w1 = await execCaptionsTool('edit_caption_words', {
  overrides: [
    { wordIndex: 1, hidden: true },
    { wordIndex: 2, text: 'brand-new' },
    { wordIndex: 3, forceBreak: true },
  ],
}, ctx) as { ok: boolean; overrides: number };
assert.equal(w1.ok, true);
assert.equal(w1.overrides, 3, 'three overrides now tracked');
assert.deepEqual(draft.getState().captions?.wordOverrides, {
  1: { hidden: true },
  2: { text: 'brand-new' },
  3: { forceBreak: true },
}, 'persisted via updateCaptions on TimelineState.captions.wordOverrides');

// read_captions 之后反映覆盖:idx1 仍列出(hidden 标记可见,方便 agent 取消隐藏),idx2 显示替换文本
type WordOut = { index: number; text: string; override: { hidden?: boolean; text?: string; forceBreak?: boolean } | null };
const r1 = await execCaptionsTool('read_captions', {}, ctx) as { pages: { words: WordOut[] }[] };
const flat1 = r1.pages.flatMap((p) => p.words);
assert.deepEqual(flat1.map((w) => w.text), ['hello', 'brave', 'brand-new', 'world'], 'text override applied; hidden word still listed (not filtered) for the agent to inspect');
assert.equal(flat1.find((w) => w.index === 1)?.override?.hidden, true);
assert.equal(flat1.find((w) => w.index === 2)?.override?.text, 'brand-new');
assert.equal(flat1.find((w) => w.index === 3)?.override?.forceBreak, true);

// clear:撤销 idx1 的覆盖
const w2 = await execCaptionsTool('edit_caption_words', { overrides: [{ wordIndex: 1, clear: true }] }, ctx) as { ok: boolean; overrides: number };
assert.equal(w2.ok, true);
assert.equal(w2.overrides, 2, 'one override cleared, two remain');
assert.equal(draft.getState().captions?.wordOverrides?.[1], undefined);

// 越界/非法 wordIndex 不静默改动,而是在 errors 里回显
const w3 = await execCaptionsTool('edit_caption_words', { overrides: [{ wordIndex: 99, hidden: true }] }, ctx) as { ok: boolean; overrides: number; errors?: string[] };
assert.equal(w3.ok, true);
assert.equal(w3.overrides, 2, 'out-of-range entry ignored, count unchanged');
assert.ok(w3.errors?.some((e) => e.includes('out of range')));

// captions 未启用时 read_captions 明确说明,不报错
const offCtx: AgentContext = { ...ctx, getState: () => ({ ...draft.getState(), captions: { ...draft.getState().captions!, enabled: false } }) };
const rOff = await execCaptionsTool('read_captions', {}, offCtx) as { enabled: boolean; note?: string };
assert.equal(rOff.enabled, false);
assert.ok(rOff.note);

console.log('captions-tools.check: ok');

// ── 3) 多源合并:resolveCaptionWords/resolveCaptionWordIndices ──────────
// fps=1000 让 frame 数与 ms 一一对应(msToFrame(ms,1000)===ms),期望值可手算、免浮点误差。
const wordsA: TranscriptWord[] = [
  { text: 'hi', start: 0, end: 100 },
  { text: 'there', start: 100, end: 200 },
];
const wordsB: TranscriptWord[] = [
  { text: 'yo', start: 0, end: 100 },
  { text: 'friend', start: 100, end: 200 },
];
const itemA = { id: 'a', track: 'A1' as const, startFrame: 0, durationInFrames: 200, name: 'spk-a', kind: 'audio' as const, src: '/a.mp3', transcript: wordsA };
const itemB = { id: 'b', track: 'A2' as const, startFrame: 50, durationInFrames: 200, name: 'spk-b', kind: 'audio' as const, src: '/b.mp3', transcript: wordsB };
const itemC = { id: 'c', track: 'A3' as const, startFrame: 0, durationInFrames: 100, name: 'no-transcript', kind: 'audio' as const, src: '/c.mp3' };
const multiState: TimelineState = {
  fps: 1000, width: 1920, height: 1080, selectedId: null,
  items: [itemA, itemB, itemC],
  captions: { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: 'a' },
};

// 单源路径(无 sources/sourceMode)字节级不变:与"合并功能加入前"完全同一段代码路径。
{
  const single = resolveCaptionWords(multiState.captions!, multiState.items, multiState.fps);
  assert.deepEqual(single, [
    { text: 'hi', start: 0, end: 100, speaker: undefined },
    { text: 'there', start: 100, end: 200, speaker: undefined },
  ], 'no sources/sourceMode → identical to the pre-merge sourceItemId-only path');
  assert.deepEqual(resolveCaptionWordIndices(multiState.captions!, multiState.items), [0, 1], 'single-source indices stay the original transcript indices');
}

// sources:['a','b'] → 两条转写合并,按绝对开始时间排序(不是简单拼接:b 的第一个词落在 a 两词之间)
{
  const merged = { ...multiState.captions!, sources: ['a', 'b'] };
  const words = resolveCaptionWords(merged, multiState.items, multiState.fps);
  assert.deepEqual(words.map((w) => w.text), ['hi', 'yo', 'there', 'friend'], 'merged + sorted by absolute start (not source concat order)');
  assert.deepEqual(words.map((w) => [w.start, w.end]), [[0, 100], [50, 150], [100, 200], [150, 250]], '护城河③: each word keeps its own text/start/end, unchanged by the merge');
  assert.deepEqual(resolveCaptionWordIndices(merged, multiState.items), [0, 1, 2, 3], 'multi-source indices are sequential positions in the merged output');
}

// sourceMode:'timeline' → 等价于"全部已转写 item"(c 没有 transcript,被自动排除)
{
  const timeline = { ...multiState.captions!, sourceMode: 'timeline' as const };
  const words = resolveCaptionWords(timeline, multiState.items, multiState.fps);
  assert.deepEqual(words.map((w) => w.text), ['hi', 'yo', 'there', 'friend'], "sourceMode:'timeline' merges every transcribed item, skips untranscribed ones");
}

console.log('captions-tools.check: multi-source merge ok');

// ── 4) set_caption_sources 工具:校验 + 落盘 + read_captions 反映合并结果 ──
const draft2 = makeDraft(docFromTimeline(multiState));
const ctx2: AgentContext = { commands: draft2.commands, getState: draft2.getState, getDoc: draft2.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// 未知/未转写 item id → 报错,不落盘
const bad = await execCaptionsTool('set_caption_sources', { sources: ['a', 'does-not-exist'] }, ctx2) as { error?: string };
assert.ok(bad.error?.includes('does-not-exist'), 'unknown item id surfaces in the error');
assert.equal(draft2.getState().captions?.sources, undefined, 'rejected call does not persist');

// 合法 sources → 落盘 + wordCount 反映合并后的词数
const ok1 = await execCaptionsTool('set_caption_sources', { sources: ['a', 'b'] }, ctx2) as { ok: boolean; sources: string[]; mode: string; wordCount: number };
assert.equal(ok1.ok, true);
assert.deepEqual(ok1.sources, ['a', 'b']);
assert.equal(ok1.mode, 'item');
assert.equal(ok1.wordCount, 4);
assert.deepEqual(draft2.getState().captions?.sources, ['a', 'b'], 'persisted via updateCaptions on TimelineState.captions.sources');

// read_captions 之后反映合并结果:四个词、按开始时间排序
const r2 = await execCaptionsTool('read_captions', {}, ctx2) as { pages: { words: { text: string }[] }[] };
assert.deepEqual(r2.pages.flatMap((p) => p.words).map((w) => w.text), ['hi', 'yo', 'there', 'friend'], 'read_captions reflects the merged word stream');

// mode:'timeline' → 落盘 mode,c(无转写)仍被排除
const ok2 = await execCaptionsTool('set_caption_sources', { mode: 'timeline' }, ctx2) as { ok: boolean; mode: string; wordCount: number };
assert.equal(ok2.ok, true);
assert.equal(ok2.mode, 'timeline');
assert.equal(ok2.wordCount, 4);
assert.equal(draft2.getState().captions?.sourceMode, 'timeline');

// 空参数 / 非法 mode → 报错,不静默改动
const empty = await execCaptionsTool('set_caption_sources', {}, ctx2) as { error?: string };
assert.ok(empty.error?.includes('nothing to update'));
const badMode = await execCaptionsTool('set_caption_sources', { mode: 'bogus' }, ctx2) as { error?: string };
assert.ok(badMode.error?.includes('invalid mode'));

console.log('captions-tools.check: set_caption_sources ok');
