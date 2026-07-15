// Runnable source-contract check: `npx tsx src/agent/transcript-tools.check.ts`.
// 聚焦 manage_transcript 的 fix(改错字)路径 + 护城河③(词↔帧双向一致)不变式。
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import type { TimelineState } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { docFromTimeline } from '../persist/projectStore';
import type { AgentContext } from './context';
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
// 护城河③:timing(start/end)、speaker、词数、clip 时长全部不变
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

// ── manage_transcript action=fix 的说话人分支(重命名/合并,源站 fix 二合一)────
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
  // 护城河③:text/timing/词数/时长全不变
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
