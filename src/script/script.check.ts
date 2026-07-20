// Runnable check for deterministic timeline.md round trips:
// `npx tsx src/script/script.check.ts`.
import assert from 'node:assert';
import type { TimelineItem, TimelineState, ProjectDoc, Timeline } from '../editor/types';
import { makeDraft } from '../editor/store';
import { serializeTimeline } from './serialize';
import { applyScript } from './apply';

// speech: two sentences → two [sN] segments (words at 500ms each)
const W = (texts: string[], t0 = 0) =>
  texts.map((text, i) => ({ text, start: t0 + i * 500, end: t0 + i * 500 + 400 }));
const speechWords = [...W(['Hello', 'brave', 'new', 'world.']), ...W(['Keep', 'this', 'sentence.'], 2000)];

const speech: TimelineItem = {
  id: 'it_speech', track: 'A1', startFrame: 0, durationInFrames: 101,
  name: 'voice.mp3', kind: 'audio', src: '/a.mp3', transcript: speechWords, deletedWordIdx: [],
};
const clipA: TimelineItem = { id: 'it_a', track: 'V1', startFrame: 0, durationInFrames: 44, name: 'a.mp4', kind: 'video', src: '/a.mp4' };
const clipB: TimelineItem = { id: 'it_b', track: 'V1', startFrame: 74, durationInFrames: 46, name: 'b.mp4', kind: 'video', src: '/b.mp4' };

const state: TimelineState = { fps: 30, width: 1920, height: 1080, items: [clipA, clipB, speech], selectedId: null };
const doc = (s: TimelineState): ProjectDoc => {
  const tl: Timeline = { ...s, id: 'tl1', name: 'T', order: 0 };
  return { version: 2, assets: [], mediaFolders: [], timelines: [tl], activeTimelineId: 'tl1' };
};

// ── 1. serialization shape + round-trip stability ──
const { md, stamp } = serializeTimeline(state);
assert.ok(md.includes('## V1') && md.includes('## A1'), 'track sections');
assert.ok(md.includes('### voice.mp3') && md.includes('[s1] Hello brave new world.'), 'seg row');
assert.ok(md.includes('[s2] Keep this sentence.'), 'second segment');
assert.ok(md.includes('[c1] 44f') && md.includes('[gap 30f]') && md.includes('[c1] 46f'), 'clip + gap rows');
assert.ok(md.includes(`script-stamp:${stamp}`), 'stamp comment');

// no-op apply: valid script, zero changes
{
  const d = makeDraft(doc(state));
  const r = applyScript(d.getState, d.commands, md);
  assert.deepStrictEqual([r.removed.length, r.changes.length], [0, 0], 'no-op apply changes nothing');
  assert.strictEqual(d.takeActions().length, 0, 'no actions recorded');
}

// ── 2. word strike → deletion (删词=删视频) ──
{
  const d = makeDraft(doc(state));
  const edited = md.replace('[s1] Hello brave new world.', '[s1] Hello ~~brave new~~ world.');
  applyScript(d.getState, d.commands, edited);
  const it = d.getState().items.find((x) => x.id === 'it_speech')!;
  assert.deepStrictEqual([...(it.deletedWordIdx ?? [])].sort(), [1, 2], 'brave+new deleted');
  assert.ok(it.durationInFrames < 101, 'duration re-derived shorter');
}

// ── 3. whole-row strike → whole segment deleted ──
{
  const d = makeDraft(doc(state));
  const edited = md.replace('[s2] Keep this sentence.', '~~[s2] Keep this sentence.~~');
  applyScript(d.getState, d.commands, edited);
  const it = d.getState().items.find((x) => x.id === 'it_speech')!;
  assert.deepStrictEqual([...(it.deletedWordIdx ?? [])].sort(), [4, 5, 6], 'segment 2 words deleted');
}

// ── 4. restore: re-adding previously deleted words ──
{
  const withDeleted: TimelineState = {
    ...state,
    items: state.items.map((it) => (it.id === 'it_speech' ? { ...it, deletedWordIdx: [1, 2], durationInFrames: 70 } : it)),
  };
  const cur = serializeTimeline(withDeleted);
  assert.ok(cur.md.includes('[s1] Hello world.'), 'deleted words absent from serialization');
  const d = makeDraft(doc(withDeleted));
  const edited = cur.md.replace('[s1] Hello world.', '[s1] Hello brave new world.');
  const r = applyScript(d.getState, d.commands, edited);
  const it = d.getState().items.find((x) => x.id === 'it_speech')!;
  assert.deepStrictEqual(it.deletedWordIdx ?? [], [], 'words restored');
  assert.ok(r.changes.some((c) => c.includes('恢复')), 'restore audited');
}

// ── 5. clip row deletion + gap close + repack ──
{
  const d = makeDraft(doc(state));
  const edited = md.replace('[c1] 44f\n', '').replace('[gap 30f]\n', '');
  const r = applyScript(d.getState, d.commands, edited);
  const s = d.getState();
  assert.ok(!s.items.some((x) => x.id === 'it_a'), 'clip a removed');
  assert.strictEqual(s.items.find((x) => x.id === 'it_b')!.startFrame, 0, 'b repacked to 0');
  assert.ok(r.removed.length >= 1, 'removal audited');
}

// ── 6. reorder clips by moving lines (frames re-derived) ──
{
  const s2: TimelineState = { ...state, items: [clipA, { ...clipB, startFrame: 44 }, speech] };
  const base2 = serializeTimeline(s2);
  const d = makeDraft(doc(s2));
  const edited = base2.md
    .replace('### a.mp4\n[c1] 44f\n### b.mp4\n[c1] 46f', '### b.mp4\n[c1] 46f\n### a.mp4\n[c1] 44f');
  applyScript(d.getState, d.commands, edited);
  const s = d.getState();
  assert.strictEqual(s.items.find((x) => x.id === 'it_b')!.startFrame, 0, 'b now first');
  assert.strictEqual(s.items.find((x) => x.id === 'it_a')!.startFrame, 46, 'a follows b');
}

// ── 7. guards: stale stamp / rewriting words / replay ──
{
  const d = makeDraft(doc(state));
  assert.throws(() => applyScript(d.getState, d.commands, md.replace(/script-stamp:\w+/, 'script-stamp:zzz')), /stale/, 'stale stamp rejected');
  assert.throws(() => applyScript(d.getState, d.commands, md.replace('Keep this sentence.', 'Keep that sentence.')), /不匹配/, 'rewritten words rejected');
  assert.throws(() => applyScript(d.getState, d.commands, md.replace('[s2] Keep', '[s2] Keep this sentence.\n[s2] Keep')), /重放|两次/, 'replay rejected');
  assert.strictEqual(d.takeActions().length, 0, 'failed applies dispatch nothing (atomic)');
}

// ── 8. tolerant matching: case/punctuation don't count as word changes ──
{
  const d = makeDraft(doc(state));
  const edited = md.replace('[s1] Hello brave new world.', '[s1] hello BRAVE ~~new~~ world');
  applyScript(d.getState, d.commands, edited);
  const it = d.getState().items.find((x) => x.id === 'it_speech')!;
  assert.deepStrictEqual([...(it.deletedWordIdx ?? [])], [2], 'only ~~new~~ deleted despite case/punct drift');
}

console.log('script.check OK');
