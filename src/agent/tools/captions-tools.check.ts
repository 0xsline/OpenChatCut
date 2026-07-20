// Runnable contract check: `npx tsx src/agent/captions-tools.check.ts`.
// 覆盖:① paginate/applyWordOverrides 纯逻辑(隐藏/换文本/强制换页/无覆盖时字节级不变);
// ② edit_captions action=display_text 经 makeDraft 落 updateCaptions,read_captions 读回;
// ③ 多源合并(resolveCaptionWords 按绝对时间排序);④ edit_captions action=source_*(选择器解析/
// 增删/timeline);⑤ 其余 action:enable/disable、template 列表+应用、style→styleOverride(sizePx→
// 比例、highlightBackground 对象→色串、pacing 路由、未映射字段进 ignored)、layout 锚点、
// language_mode;三兄弟(positions/layout_policy/source_update)真派发(详测在 captions-lanes.check.ts)。
import assert from 'node:assert/strict';
import { paginate } from '../../captions/types';
import type { TranscriptWord } from '../../transcript/types';
import { applyWordOverrides, resolveCaptionWords, resolveCaptionWordIndices } from '../../captions/resolve';
import { __resetCaptionPresetMemory } from '../../captions/presetStore';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
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

// edit_captions action=display_text:隐藏 idx1,替换 idx2 文本,idx3 强制换页(forcePageBreak)
const w1 = await execCaptionsTool('edit_captions', {
  action: 'display_text',
  json: {
    overrides: [
      { wordIndex: 1, hidden: true },
      { wordIndex: 2, text: 'brand-new' },
      { wordIndex: 3, forcePageBreak: true },
    ],
  },
}, ctx) as { ok: boolean; overrides: number };
assert.equal(w1.ok, true);
assert.equal(w1.overrides, 3, 'three overrides now tracked');
assert.deepEqual(draft.getState().captions?.wordOverrides, {
  1: { hidden: true },
  2: { text: 'brand-new' },
  3: { forceBreak: true },
}, 'persisted via updateCaptions on TimelineState.captions.wordOverrides (forcePageBreak → forceBreak)');
// json 作为字符串传入时也应等价解析
const w1s = await execCaptionsTool('edit_captions', { action: 'display_text', json: JSON.stringify({ overrides: [{ wordIndex: 0, hidden: true }] }) }, ctx) as { ok: boolean };
assert.equal(w1s.ok, true, 'json-as-string parses');
assert.equal(draft.getState().captions?.wordOverrides?.[0]?.hidden, true);
await execCaptionsTool('edit_captions', { action: 'display_text', json: { overrides: [{ wordIndex: 0, clear: true }] } }, ctx);

// read_captions 之后反映覆盖:idx1 仍列出(hidden 标记可见,方便 agent 取消隐藏),idx2 显示替换文本
type WordOut = { index: number; text: string; override: { hidden?: boolean; text?: string; forceBreak?: boolean } | null };
const r1 = await execCaptionsTool('read_captions', {}, ctx) as { pages: { words: WordOut[] }[] };
const flat1 = r1.pages.flatMap((p) => p.words);
assert.deepEqual(flat1.map((w) => w.text), ['hello', 'brave', 'brand-new', 'world'], 'text override applied; hidden word still listed (not filtered) for the agent to inspect');
assert.equal(flat1.find((w) => w.index === 1)?.override?.hidden, true);
assert.equal(flat1.find((w) => w.index === 2)?.override?.text, 'brand-new');
assert.equal(flat1.find((w) => w.index === 3)?.override?.forceBreak, true);

// clear:撤销 idx1 的覆盖
const w2 = await execCaptionsTool('edit_captions', { action: 'display_text', json: { overrides: [{ wordIndex: 1, clear: true }] } }, ctx) as { ok: boolean; overrides: number };
assert.equal(w2.ok, true);
assert.equal(w2.overrides, 2, 'one override cleared, two remain');
assert.equal(draft.getState().captions?.wordOverrides?.[1], undefined);

// 越界/非法 wordIndex 不静默改动,而是在 errors 里回显
const w3 = await execCaptionsTool('edit_captions', { action: 'display_text', json: { overrides: [{ wordIndex: 99, hidden: true }] } }, ctx) as { ok: boolean; overrides: number; errors?: string[] };
assert.equal(w3.ok, true);
assert.equal(w3.overrides, 2, 'out-of-range entry ignored, count unchanged');
assert.ok(w3.errors?.some((e) => e.includes('out of range')));

// 回归(审计 B1):text:null 清一个从未 override 过的词 = no-op,不许抛 TypeError
const wNull = await execCaptionsTool('edit_captions', { action: 'display_text', json: { overrides: [{ wordIndex: 3, text: null }] } }, ctx) as { ok: boolean };
assert.equal(wNull.ok, true, 'text:null on a never-overridden word is a safe no-op');

// clearOverrides:一次清空所有逐词覆盖
const wClr = await execCaptionsTool('edit_captions', { action: 'display_text', json: { clearOverrides: true } }, ctx) as { ok: boolean; cleared: boolean };
assert.equal(wClr.cleared, true);
assert.deepEqual(draft.getState().captions?.wordOverrides, {}, 'clearOverrides empties the override map');

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
  assert.deepEqual(resolveCaptionWordIndices(multiState.captions!, multiState.items, multiState.fps), [0, 1], 'single-source indices stay the original transcript indices');
}

// sources:['a','b'] → 两条转写合并,按绝对开始时间排序(不是简单拼接:b 的第一个词落在 a 两词之间)
{
  const merged = { ...multiState.captions!, sources: ['a', 'b'] };
  const words = resolveCaptionWords(merged, multiState.items, multiState.fps);
  assert.deepEqual(words.map((w) => w.text), ['hi', 'yo', 'there', 'friend'], 'merged + sorted by absolute start (not source concat order)');
  assert.deepEqual(words.map((w) => [w.start, w.end]), [[0, 100], [50, 150], [100, 200], [150, 250]], 'each word keeps its own text/start/end, unchanged by the merge');
  assert.deepEqual(resolveCaptionWordIndices(merged, multiState.items, multiState.fps), [0, 1, 2, 3], 'multi-source indices are sequential positions in the merged output');
}

// sourceMode:'timeline' → 等价于"全部已转写 item"(c 没有 transcript,被自动排除)
{
  const timeline = { ...multiState.captions!, sourceMode: 'timeline' as const };
  const words = resolveCaptionWords(timeline, multiState.items, multiState.fps);
  assert.deepEqual(words.map((w) => w.text), ['hi', 'yo', 'there', 'friend'], "sourceMode:'timeline' merges every transcribed item, skips untranscribed ones");
}

// video 源:窗口内"可闻即显"——video 连续播放 [srcIn,srcIn+dur),transcript 删词
// 不隐藏字幕(否则 agent 的删词选区比 srcIn 窗口窄时,短片开头几秒有人说话没字幕;
// 2026-07-17 长转短实测抓获)。字幕层藏词走 wordOverrides,不走 deletedWordIdx。
{
  const vid = {
    id: 'v', track: 'V1' as const, startFrame: 0, durationInFrames: 100, name: 'talk',
    kind: 'video' as const, src: '/talk.mp4', srcInFrame: 50, deletedWordIdx: [0],
    transcript: [
      { text: 'lead', start: 60, end: 80 },   // 窗口内、被删 → 仍显示(可闻)
      { text: 'kept', start: 90, end: 110 },  // 窗口内、未删
      { text: 'out', start: 200, end: 220 },  // 窗外(win=[50,150))
    ],
  };
  const capV = { enabled: true, template: 'plain' as const, pacing: 'phrase' as const, sourceItemId: 'v' };
  const words = resolveCaptionWords(capV, [vid], 1000);
  assert.deepEqual(words.map((w) => w.text), ['lead', 'kept'], 'video 窗口内删词仍显示(可闻即显),窗外裁掉');
  assert.deepEqual(words.map((w) => Math.round(w.start)), [10, 40], '媒体帧 − srcIn + startFrame 直投,删词不重排');
  assert.deepEqual(resolveCaptionWordIndices(capV, [vid], 1000), [0, 1], '索引与词同一套存活规则(wordOverrides 键)');
}

console.log('captions-tools.check: multi-source merge + video 可闻即显 ok');

// ── 4) edit_captions action=source_* :校验 + 落盘 + read_captions 反映合并结果 ──
const draft2 = makeDraft(docFromTimeline(multiState));
const ctx2: AgentContext = { commands: draft2.commands, getState: draft2.getState, getDoc: draft2.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// 未知/未转写 selector → 报错,不落盘
const bad = await execCaptionsTool('edit_captions', { action: 'source_set', json: { sources: [{ itemId: 'a' }, { itemId: 'does-not-exist' }] } }, ctx2) as { error?: string };
assert.ok(bad.error?.includes('does-not-exist'), 'unresolved selector surfaces in the error');
assert.equal(draft2.getState().captions?.sources, undefined, 'rejected call does not persist');
assert.equal(draft2.getState().captions?.sourceEntries, undefined, 'rejected call does not persist entries either');

// 合法 sources(选择器数组)→ 落盘 item ids + wordCount 反映合并后的词数
const ok1 = await execCaptionsTool('edit_captions', { action: 'source_set', json: { sources: [{ itemId: 'a' }, { trackId: 'A2' }] } }, ctx2) as { ok: boolean; sources: Array<{ itemId: string; sourceId: string }>; wordCount: number };
assert.equal(ok1.ok, true);
assert.deepEqual(ok1.sources.map((r) => r.itemId), ['a', 'b'], 'selectors resolved (trackId A2 → item b), rich entry rows');
assert.ok(ok1.sources.every((r) => r.sourceId), 'each source carries a stable sourceId');
assert.equal(ok1.wordCount, 4);
assert.deepEqual(draft2.getState().captions?.sourceEntries?.map((e) => e.itemId), ['a', 'b'], 'persisted as sourceEntries (multi-lane scope)');
assert.equal(draft2.getState().captions?.sources, undefined, 'legacy sources[] cleared when entries take over');

// read_captions 反映合并结果:四个词、按开始时间排序
const r2 = await execCaptionsTool('read_captions', {}, ctx2) as { pages: { words: { text: string }[] }[] };
assert.deepEqual(r2.pages.flatMap((p) => p.words).map((w) => w.text), ['hi', 'yo', 'there', 'friend'], 'read_captions reflects the merged word stream');

// source_add 追加一条;source_remove 按 index 移除
const add = await execCaptionsTool('edit_captions', { action: 'source_add', json: { source: { itemId: 'a' } } }, ctx2) as { ok: boolean; sources: Array<{ itemId: string }> };
assert.deepEqual(add.sources.map((r) => r.itemId), ['a', 'b'], 'source_add dedups (a already present)');
const rm = await execCaptionsTool('edit_captions', { action: 'source_remove', json: { index: 1 } }, ctx2) as { ok: boolean; sources: Array<{ itemId: string }> };
assert.deepEqual(rm.sources.map((r) => r.itemId), ['a'], 'source_remove by index drops b');

// mode:'timeline' → 落盘 mode
const ok2 = await execCaptionsTool('edit_captions', { action: 'source_set', json: { mode: 'timeline' } }, ctx2) as { ok: boolean; sourceMode: string; wordCount: number };
assert.equal(ok2.sourceMode, 'timeline');
assert.equal(ok2.wordCount, 4);
assert.equal(draft2.getState().captions?.sourceMode, 'timeline');

// 空 source_set → 报错
const empty = await execCaptionsTool('edit_captions', { action: 'source_set', json: {} }, ctx2) as { error?: string };
assert.ok(empty.error, 'empty source_set errors');

console.log('captions-tools.check: source_* ok');

// ── 5) 新增 action:enable/disable · template · style(→styleOverride) · layout · unsupported ──
const draft3 = makeDraft(docFromTimeline({ ...state, captions: undefined }));
const ctx3: AgentContext = { commands: draft3.commands, getState: draft3.getState, getDoc: draft3.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// enable:无 captions 时新建(有转写源)
const en = await execCaptionsTool('edit_captions', { action: 'enable', preset: 'netflix' }, ctx3) as { ok: boolean; enabled: boolean; template: string };
assert.equal(en.enabled, true);
assert.equal(en.template, 'netflix', 'enable preset picks the template');
assert.equal(draft3.getState().captions?.sourceItemId, 'clip', 'enable anchors to the transcribed clip');

// template 无参 → 列全部内建(21 源套系 + 黑底白字默认);应用一个 → 只改 template,保留其它
const tlist = await execCaptionsTool('edit_captions', { action: 'template' }, ctx3) as { presets: { id: string }[] };
assert.equal(tlist.presets.length, 22, 'lists all built-in presets (21 + black-bar)');
await execCaptionsTool('edit_captions', { action: 'template', templatePreset: 'bili' }, ctx3);
assert.equal(draft3.getState().captions?.template, 'bili');

// style:sizePx→fontSize 比例、color、highlightBackground 落进 styleOverride;maxLines 不支持→ignored
const st = await execCaptionsTool('edit_captions', { action: 'style', json: { sizePx: 108, color: '#ff0', highlightBackground: { color: '#123' }, maxLines: 2, pacing: 'word' } }, ctx3) as { ok: boolean; applied: string[]; pacing?: string; ignored?: string[] };
assert.equal(st.ok, true);
const so = draft3.getState().captions?.styleOverride;
assert.ok(so && Math.abs((so.fontSize ?? 0) - 108 / 1080) < 1e-9, 'sizePx→fontSize ratio (108/1080)');
assert.equal(so?.color, '#ff0');
assert.equal(so?.highlightBackground, '#123', 'highlightBackground object → color string');
assert.equal(st.pacing, 'word', 'pacing routed to CaptionsData.pacing');
assert.equal(draft3.getState().captions?.pacing, 'word');
assert.ok(st.ignored?.some((k) => k.startsWith('maxLines')), 'unmapped style field reported in ignored');

// layout:锚点 top-center + 偏移 → CaptionsData.layout
const ly = await execCaptionsTool('edit_captions', { action: 'layout', json: { preset: 'top-center', offsetYRatio: 0.05 } }, ctx3) as { ok: boolean; layout: { anchor: string; offsetYRatio: number } };
assert.equal(ly.layout.anchor, 'top-center');
assert.equal(draft3.getState().captions?.layout?.anchor, 'top-center');

// language_mode original(无需 LLM)清翻译态;translation 无变体 → 报错
await execCaptionsTool('edit_captions', { action: 'language_mode', json: { mode: 'original' } }, ctx3);
assert.equal(draft3.getState().captions?.bilingual, false);
const noVar = await execCaptionsTool('edit_captions', { action: 'language_mode', json: { mode: 'translation', languageCode: 'en' } }, ctx3) as { error?: string };
assert.ok(noVar.error?.includes('variant'), 'translation without a variant asks to translate first');

// 三兄弟已是真实现(captions-lanes.ts;详测在 captions-lanes.check.ts)——这里只验派发通了
const pos = await execCaptionsTool('edit_captions', { action: 'positions', json: {} }, ctx3) as { error?: string; unsupported?: boolean };
assert.ok(pos.error && !pos.unsupported, 'positions dispatches for real (empty json → validation error, not unsupported)');
const supd = await execCaptionsTool('edit_captions', { action: 'source_update', json: { updates: [{ index: 0, anchor: 'bottom-center', offsetYRatio: -0.08 }] } }, ctx3) as { ok?: boolean; error?: string; unsupported?: boolean };
assert.ok(!supd.unsupported && supd.ok === true, `source_update is a real implementation now: ${JSON.stringify(supd)}`);
assert.equal(draft3.getState().captions?.sourceEntries?.[0]?.anchor, 'bottom-center', 'per-source anchor persisted');
// user style presets (preset_save/list/apply/rename/delete) — IDB memory-fallback here
__resetCaptionPresetMemory();
const psave = await execCaptionsTool('edit_captions', { action: 'preset_save', presetName: '我的风格' }, ctx3) as { ok?: boolean; presetId?: string };
assert.equal(psave.ok, true, 'preset_save succeeds with a name');
assert.ok(psave.presetId, 'preset_save returns an id');
const pnoName = await execCaptionsTool('edit_captions', { action: 'preset_save', json: {} }, ctx3) as { error?: string };
assert.ok(pnoName.error, 'preset_save without a name errors (not a silent save)');
const plist = await execCaptionsTool('edit_captions', { action: 'preset_list' }, ctx3) as { presets: { id: string; name: string }[] };
assert.ok(plist.presets.some((p) => p.id === psave.presetId && p.name === '我的风格'), 'preset_list shows the saved preset');
const papply = await execCaptionsTool('edit_captions', { action: 'preset_apply', presetId: psave.presetId }, ctx3) as { ok?: boolean; applied?: string };
assert.equal(papply.ok, true, 'preset_apply by id succeeds');
const pdel = await execCaptionsTool('edit_captions', { action: 'preset_delete', presetId: psave.presetId }, ctx3) as { ok?: boolean };
assert.equal(pdel.ok, true, 'preset_delete succeeds');
const plist2 = await execCaptionsTool('edit_captions', { action: 'preset_list' }, ctx3) as { presets: unknown[] };
assert.equal(plist2.presets.length, 0, 'preset gone after delete');
__resetCaptionPresetMemory();

// disable
const dis = await execCaptionsTool('edit_captions', { action: 'disable' }, ctx3) as { enabled: boolean };
assert.equal(dis.enabled, false);
assert.equal(draft3.getState().captions?.enabled, false);

console.log('captions-tools.check: actions (enable/template/style/layout/三兄弟派发) ok');
