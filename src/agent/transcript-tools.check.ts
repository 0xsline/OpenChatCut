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
const eAction = await execTranscriptTool('manage_transcript', { action: 'translate', itemId: 'clip', wordIndex: 0, text: 'x' }, ctx) as { error?: string };
assert.ok(eAction.error, 'unsupported action returns an error');
// 错误路径未落任何改动
assert.strictEqual(draft.getState().items[0].transcript![0].text, 'hello', 'no mutation on error paths');

// ── manage_transcript action=renameSpeaker(说话人重命名/合并)────────────────
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
  const r = await execTranscriptTool('manage_transcript', { action: 'renameSpeaker', itemId: 'clip', from: 'A', to: '主持人' }, c) as { ok: boolean; from: string; to: string; wordsChanged: number };
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
  const r = await execTranscriptTool('manage_transcript', { action: 'renameSpeaker', itemId: 'clip', from: 'B', to: 'A' }, c) as { ok: boolean; wordsChanged: number };
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
  const e = await execTranscriptTool('manage_transcript', { action: 'renameSpeaker', itemId: 'clip', from: 'Z', to: 'x' }, c) as { error?: string };
  assert.ok(e.error, 'unknown speaker returns an error');
  assert.deepStrictEqual(d.getState().items[0].transcript!.map((w) => w.speaker), before, 'no mutation on unknown from');
}

console.log('transcript-tools.check: ok');
