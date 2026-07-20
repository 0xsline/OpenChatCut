// Runnable contract check: `npx tsx src/agent/transcript-tools.check.ts`.
// 聚焦 manage_transcript 的 fix(改错字)路径与词帧双向一致不变式。
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import type { TranscriptWord } from '../../transcript/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execTranscriptTool } from './transcript-tools';

// durationInFrames 故意设成与转写词无关的 24 帧,用来证明改错字不会重算时长。
const words: TranscriptWord[] = [
  { text: 'hello', start: 0, end: 200, speaker: 'A' },
  { text: 'wrold', start: 200, end: 500, speaker: 'A' },
  { text: 'today', start: 500, end: 800, speaker: 'A' },
];
const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [{ id: 'clip', track: 'A1', startFrame: 0, durationInFrames: 24, name: 'vo', kind: 'audio', src: '/vo.mp3', transcript: words }],
};
const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

// 1) 按 wordIndex 改错字:'wrold' → 'world'
const r1 = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', wordIndex: 1, text: 'world' }, ctx) as { ok: boolean; wordIndex: number; from: string; to: string };
assert.strictEqual(r1.ok, true);
assert.strictEqual(r1.from, 'wrold');
assert.strictEqual(r1.to, 'world');

const after = draft.getState().items.find((it) => it.id === 'clip')!;
assert.strictEqual(after.transcript![1].text, 'world', 'only .text changed');
// timing(start/end)、speaker、词数、clip 时长全部不变。
assert.strictEqual(after.transcript![1].start, 200, 'start untouched');
assert.strictEqual(after.transcript![1].end, 500, 'end untouched');
assert.strictEqual(after.transcript![1].speaker, 'A', 'speaker untouched');
assert.strictEqual(after.transcript!.length, 3, 'word count unchanged');
assert.strictEqual(after.durationInFrames, 24, 'clip duration unchanged');
// 相邻词未被波及
assert.strictEqual(after.transcript![0].text, 'hello');
assert.strictEqual(after.transcript![2].text, 'today');

// 2) 按 find 改错字:'today' → 'tomorrow',并验证定位到正确下标
const r2 = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', find: 'today', text: 'tomorrow' }, ctx) as { ok: boolean; wordIndex: number };
assert.strictEqual(r2.ok, true);
assert.strictEqual(r2.wordIndex, 2, 'find locates the right index');
const after2 = draft.getState().items[0];
assert.strictEqual(after2.transcript![2].text, 'tomorrow');
assert.strictEqual(after2.transcript![2].start, 500, 'find-fix leaves timing intact');
assert.strictEqual(after2.durationInFrames, 24, 'duration still unchanged after 2nd fix');
assert.strictEqual(after2.transcript!.length, 3);

// 3) 错误路径都返回 error,不静默改
const eItem = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'nope', wordIndex: 0, text: 'x' }, ctx) as { error?: string };
assert.ok(eItem.error, 'unknown item returns an error');
const eWord = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', wordIndex: 99, text: 'x' }, ctx) as { error?: string };
assert.ok(eWord.error, 'out-of-range word returns an error');
const eFind = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', find: 'zzz', text: 'x' }, ctx) as { error?: string };
assert.ok(eFind.error, 'unmatched find returns an error');
const eAction = await execTranscriptTool('manage_transcript', { action: 'bogus_action', itemId: 'clip', wordIndex: 0, text: 'x' }, ctx) as { error?: string };
assert.ok(eAction.error, 'unsupported action returns an error');
// 错误路径未落任何改动
assert.strictEqual(draft.getState().items[0].transcript![0].text, 'hello', 'no mutation on error paths');

// ── manage_transcript action=fix 的说话人分支(重命名/合并)────
// 两位说话人 A/B;durationInFrames 同样设成与词无关的 24 帧,证明重命名不重算时长。
const spWords: TranscriptWord[] = [
  { text: '大家好', start: 0, end: 300, speaker: 'A' },
  { text: '你好', start: 300, end: 600, speaker: 'B' },
  { text: '再见', start: 600, end: 900, speaker: 'A' },
];
const spState = (): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [{ id: 'clip', track: 'A1', startFrame: 0, durationInFrames: 24, name: 'vo', kind: 'audio', src: '/vo.mp3', transcript: spWords }],
});
const mkSpCtx = () => {
  const d = makeDraft(docFromTimeline(spState()));
  const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
  return { d, c };
};

// 4) 重命名:'A' → '主持人'(两个 A 词都改标,B 不动)
{
  const { d, c } = mkSpCtx();
  const r = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', from: 'A', to: '主持人' }, c) as { ok: boolean; from: string; to: string; wordsChanged: number };
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.from, 'A');
  assert.strictEqual(r.to, '主持人');
  assert.strictEqual(r.wordsChanged, 2, 'both A words changed');
  const t = d.getState().items[0].transcript!;
  assert.strictEqual(t[0].speaker, '主持人');
  assert.strictEqual(t[2].speaker, '主持人');
  assert.strictEqual(t[1].speaker, 'B', 'B speaker untouched');
// text/timing/词数/时长全不变。
  assert.strictEqual(t[0].text, '大家好', 'text untouched');
  assert.strictEqual(t[0].start, 0, 'start untouched');
  assert.strictEqual(t[2].end, 900, 'end untouched');
  assert.strictEqual(t.length, 3, 'word count unchanged');
  assert.strictEqual(d.getState().items[0].durationInFrames, 24, 'duration unchanged');
}

// 5) 合并:'B' → 'A'(B 塌进 A,全部同一说话人),同样只动 speaker
{
  const { d, c } = mkSpCtx();
  const r = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', from: 'B', to: 'A' }, c) as { ok: boolean; wordsChanged: number };
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wordsChanged, 1, 'the one B word merged');
  const t = d.getState().items[0].transcript!;
  assert.ok(t.every((w) => w.speaker === 'A'), 'B collapsed into A → single speaker');
  assert.deepStrictEqual(t.map((w) => w.text), ['大家好', '你好', '再见'], 'text untouched by merge');
  assert.strictEqual(t.length, 3);
  assert.strictEqual(d.getState().items[0].durationInFrames, 24);
}

// 6) 未知 from → error,不改动任何东西(no-op guard)
{
  const { d, c } = mkSpCtx();
  const before = d.getState().items[0].transcript!.map((w) => w.speaker);
  const e = await execTranscriptTool('manage_transcript', { action: 'fix', itemId: 'clip', from: 'Z', to: 'x' }, c) as { error?: string };
  assert.ok(e.error, 'unknown speaker returns an error');
  assert.deepStrictEqual(d.getState().items[0].transcript!.map((w) => w.speaker), before, 'no mutation on unknown from');
}

// ── 翻译变体 6-action:list / read / ensure(复用) / create·read 缺 lang / retry 无源 ──
// 预置一个 en 译文变体(不跑 LLM),覆盖非联网路径;translation_ensure 命中即复用。
const varWords: TranscriptWord[] = [
  { text: '你好', start: 0, end: 300, speaker: 'A' },
  { text: '世界', start: 300, end: 600, speaker: 'A' },
];
const varState: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [{
    id: 'clip', track: 'A1', startFrame: 0, durationInFrames: 24, name: 'vo', kind: 'audio', src: '/vo.mp3', transcript: varWords,
    variants: [{ id: 'v_en', lang: 'English', kind: 'translation', label: 'English', words: [{ i: 0, text: 'hello' }, { i: 1, text: 'world' }] }],
  }],
};
{
  const d = makeDraft(docFromTimeline(varState));
  const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

  // translation_list:原文 + 已有 en 变体
  const list = await execTranscriptTool('manage_transcript', { action: 'translation_list', itemId: 'clip' }, c) as { ok: boolean; original: { words: number }; variants: { id: string; lang: string; words: number }[] };
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.original.words, 2);
  assert.strictEqual(list.variants.length, 1);
  assert.strictEqual(list.variants[0].lang, 'English');

  // translation_read:读回 en 译文词
  const read = await execTranscriptTool('manage_transcript', { action: 'translation_read', itemId: 'clip', lang: 'English' }, c) as { ok: boolean; words: number; text: string };
  assert.strictEqual(read.words, 2);
  assert.ok(read.text.includes('hello') && read.text.includes('world'), 'read returns the translated words');

  // translation_ensure:同 lang 已存在 → 复用,不跑 LLM(reused:true)
  const ens = await execTranscriptTool('manage_transcript', { action: 'translation_ensure', itemId: 'clip', lang: 'English' }, c) as { ok: boolean; reused: boolean; variantId: string };
  assert.strictEqual(ens.reused, true, 'ensure reuses the existing variant (no network)');
  assert.strictEqual(ens.variantId, 'v_en');

  // 缺 lang / 未知语言 / 无源重转 → 明确 error,不静默
  const noLang = await execTranscriptTool('manage_transcript', { action: 'translation_create', itemId: 'clip' }, c) as { error?: string };
  assert.ok(noLang.error, 'translation_create without lang errors');
  const noVar = await execTranscriptTool('manage_transcript', { action: 'translation_read', itemId: 'clip', lang: '日本語' }, c) as { error?: string };
  assert.ok(noVar.error, 'reading a missing variant errors');
}

// clean_script 是「整轨批处理」——必须清该轨上每个带转写的 clip,不能只清第一个(E2E 实测的 bug)
{
  const w = (t: string): TranscriptWord[] => [{ text: t, start: 0, end: 200, speaker: 'A' }, { text: t + '2', start: 1400, end: 1600, speaker: 'A' }];
  const twoClips: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [
      { id: 'a', track: 'A1', startFrame: 0, durationInFrames: 60, name: 'vo-a', kind: 'audio', src: '/a.mp3', transcript: w('x') },
      { id: 'b', track: 'A1', startFrame: 60, durationInFrames: 60, name: 'vo-b', kind: 'audio', src: '/b.mp3', transcript: w('y') },
      { id: 'notr', track: 'A1', startFrame: 120, durationInFrames: 30, name: 'silent', kind: 'audio', src: '/c.mp3' },
    ],
  };
  const d = makeDraft(docFromTimeline(twoClips));
  const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
  const whole = await execTranscriptTool('clean_script', { track: 'A1', maxPauseSeconds: 0.5 }, c) as { ok: boolean; clips: number; itemIds: string[] };
  assert.strictEqual(whole.clips, 2, 'clean_script cleans BOTH transcribed clips on the track (not just the first)');
  assert.deepStrictEqual([...whole.itemIds].sort(), ['a', 'b'], 'untranscribed clip skipped');
  const one = await execTranscriptTool('clean_script', { itemId: 'b', maxPauseSeconds: 0.5 }, c) as { clips: number; itemIds: string[] };
  assert.strictEqual(one.clips, 1, 'itemId narrows to a single clip');
  assert.deepStrictEqual(one.itemIds, ['b']);
}

// ── find_transcript 参数:fuzzy / includeWordTimestamps / limit / asset ──
{
  // "we use davinci um resolve daily" @30fps — 'um' 是 query token 之间的填充词
  const w = (text: string, s: number, e: number): TranscriptWord => ({ text, start: s, end: e, speaker: 'A' });
  const ftWords = [w('we', 0, 200), w('use', 200, 400), w('davinci', 400, 800), w('um', 800, 900), w('resolve', 900, 1300), w('daily', 1300, 1600)];
  const ftState: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [{ id: 'ft', track: 'A1', startFrame: 60, durationInFrames: 48, name: 'vo', kind: 'audio', src: '/vo.mp3', transcript: ftWords }],
  };
  const d = makeDraft(docFromTimeline(ftState));
  const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

  // 连续匹配命中 + 旧字段向后兼容(itemId/wordStart/wordCount/text/fromFrame/toFrame 仍平铺在顶层)
  const exact = await execTranscriptTool('find_transcript', { query: 'DaVinci' }, c) as {
    found: boolean; itemId: string; wordStart: number; wordCount: number; fromFrame: number; toFrame: number; matchCount: number;
    matches: Array<{ itemId: string; fromFrame: number }>;
  };
  assert.strictEqual(exact.found, true);
  assert.strictEqual(exact.itemId, 'ft', 'legacy top-level itemId kept');
  assert.strictEqual(exact.wordStart, 2);
  assert.strictEqual(exact.wordCount, 1);
  // 词→帧与播放层同源:clip 从 startFrame 起播首个 kept 词,davinci 起于 400ms → 60 + 12
  assert.strictEqual(exact.fromFrame, 72, 'word frame = startFrame + source-offset frames');
  assert.strictEqual(exact.matchCount, 1);
  assert.strictEqual(exact.matches.length, 1, 'matches[] array present');

  // 默认(非 fuzzy):token 间有填充词 → 不命中
  const strict = await execTranscriptTool('find_transcript', { query: 'davinci resolve' }, c) as { found: boolean };
  assert.strictEqual(strict.found, false, 'contiguous match does not jump over "um"');

  // fuzzy:token 滑窗跨过填充词命中,span 覆盖 davinci..resolve
  const fuzzy = await execTranscriptTool('find_transcript', { query: 'davinci resolve', fuzzy: true }, c) as {
    found: boolean; text: string; wordStart: number; wordCount: number; fromFrame: number; toFrame: number;
  };
  assert.strictEqual(fuzzy.found, true, 'fuzzy tolerates fillers between tokens');
  assert.strictEqual(fuzzy.wordStart, 2);
  assert.strictEqual(fuzzy.wordCount, 3, 'covering span includes the filler');
  assert.ok(fuzzy.text.includes('davinci') && fuzzy.text.includes('resolve'));
  assert.strictEqual(fuzzy.fromFrame, 72);
  assert.strictEqual(fuzzy.toFrame, 60 + Math.round((1300 / 1000) * 30), 'span end = resolve\'s end');

  // includeWordTimestamps:match 下逐词 Words 块(帧 + 秒)
  const withWords = await execTranscriptTool('find_transcript', { query: 'davinci resolve', fuzzy: true, includeWordTimestamps: true }, c) as {
    matches: Array<{ words: Array<{ text: string; fromFrame: number; toFrame: number; startSeconds: number; endSeconds: number }> }>;
  };
  const words = withWords.matches[0]!.words;
  assert.strictEqual(words.length, 3, 'per-word timestamps for every word in the span');
  assert.deepStrictEqual(words.map((x) => x.text), ['davinci', 'um', 'resolve']);
  assert.strictEqual(words[0]!.fromFrame, 72);
  assert.strictEqual(words[0]!.startSeconds, 2.4, 'seconds derived from timeline frames');
  assert.ok(words[2]!.fromFrame > words[0]!.fromFrame, 'word times ascend');
  const noWords = await execTranscriptTool('find_transcript', { query: 'davinci' }, c) as { matches: Array<Record<string, unknown>> };
  assert.ok(!('words' in noWords.matches[0]!), 'Words block only when includeWordTimestamps=true');

  // limit 截断多命中
  const many = await execTranscriptTool('find_transcript', { query: 'e' }, c) as { matchCount: number };
  assert.ok(many.matchCount >= 2, 'multiple hits found without limit');
  const limited = await execTranscriptTool('find_transcript', { query: 'e', limit: 1 }, c) as { matchCount: number; matches: unknown[] };
  assert.strictEqual(limited.matchCount, 1, 'limit truncates results');

  // timeline 模式尊重剪辑:删掉 resolve 后 fuzzy 也不再命中
  d.commands.deleteWords('ft', [4]);
  const afterDelete = await execTranscriptTool('find_transcript', { query: 'davinci resolve', fuzzy: true }, c) as { found: boolean };
  assert.strictEqual(afterDelete.found, false, 'edited-out words no longer match (timeline mode)');
}

// find_transcript asset 模式:查资产 RAW 转写(无视剪辑),秒坐标 + 摆放位置
{
  const aw: TranscriptWord[] = [
    { text: 'brand', start: 0, end: 300, speaker: 'A' },
    { text: 'intro', start: 300, end: 700, speaker: 'A' },
  ];
  const st: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [{ id: 'placed', track: 'A1', startFrame: 0, durationInFrames: 21, name: 'vo', kind: 'audio', src: '/media/uploads/vo.mp3', transcript: aw }],
    assets: [{ id: 'asset_vo_1', name: 'vo.mp3', kind: 'audio', src: '/media/uploads/vo.mp3', durationInFrames: 21, transcript: aw }],
  };
  const d = makeDraft(docFromTimeline(st));
  const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };

  const byAsset = await execTranscriptTool('find_transcript', { query: 'intro', asset: 'asset_vo' }, c) as {
    found: boolean; mode: string; asset: { id: string }; matches: Array<{ startSeconds: number; endSeconds: number }>; placements: Array<{ itemId: string }>;
  };
  assert.strictEqual(byAsset.found, true, 'asset prefix search hits');
  assert.strictEqual(byAsset.mode, 'asset');
  assert.strictEqual(byAsset.asset.id, 'asset_vo_1');
  assert.strictEqual(byAsset.matches[0]!.startSeconds, 0.3, 'asset mode reports RAW source seconds');
  assert.strictEqual(byAsset.matches[0]!.endSeconds, 0.7);
  assert.deepStrictEqual(byAsset.placements, [{ itemId: 'placed', track: 'A1' }], 'timeline placements listed');

  const noAsset = await execTranscriptTool('find_transcript', { query: 'intro', asset: 'ghost' }, c) as { error?: string };
  assert.ok(noAsset.error, 'unknown asset errors');
}

// retry_transcription 无 media src → 明确 error(不跑网络)
{
  const noSrc: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [{ id: 'clip', track: 'A1', startFrame: 0, durationInFrames: 24, name: 'vo', kind: 'audio', src: '', transcript: varWords }],
  };
  const d = makeDraft(docFromTimeline(noSrc));
  const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
  const e = await execTranscriptTool('manage_transcript', { action: 'retry_transcription', itemId: 'clip' }, c) as { error?: string };
  assert.ok(e.error, 'retry with no media src errors (no network call)');
}

console.log('transcript-tools.check: ok');
