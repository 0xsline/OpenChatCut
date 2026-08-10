// Runnable contract check: `npx tsx src/agent/highlight-tool.check.ts`.
// 覆盖智能切片(长转短)的确定性内核:N 段高光→N 条竖屏序列、裁到高光帧区间、
// 校验词帧一致、切点落在词边界且不改任何词的文本/时间,以及对不可信 LLM
// 输出(越界/重叠)的校验。LLM 用 stub 喂 canned JSON,绝不联网。
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import type { TranscriptWord } from '../../transcript/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execHighlightTool, validateHighlights, setHighlightSelector } from './highlight-tool';

// fps 30 → msToFrame(ms)=round(ms/1000*30):0→0,500→15,1000→30,1400→42,1700→51,2000→60,2600→78,3000→90,3500→105
const words: TranscriptWord[] = [
  { text: 'hello', start: 0, end: 500, speaker: 'A' },
  { text: 'world', start: 500, end: 1000, speaker: 'A' },
  { text: 'this', start: 1000, end: 1400, speaker: 'A' },
  { text: 'is', start: 1400, end: 1700, speaker: 'A' },
  { text: 'the', start: 1700, end: 2000, speaker: 'A' },
  { text: 'best', start: 2000, end: 2600, speaker: 'A' },
  { text: 'part', start: 2600, end: 3000, speaker: 'A' },
  { text: 'ever', start: 3000, end: 3500, speaker: 'A' },
];

const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [
    { id: 'talk', track: 'V1', startFrame: 0, durationInFrames: 105, name: '口播', kind: 'video', src: '/talk.mp4', transcript: words },
    { id: 'ov', track: 'V2', startFrame: 60, durationInFrames: 30, name: '覆盖MG', kind: 'motion-graphic', code: '' },
    { id: 'far', track: 'V2', startFrame: 200, durationInFrames: 30, name: '远处MG', kind: 'motion-graphic', code: '' },
  ],
};

const draft = makeDraft(docFromTimeline(state));
const ctx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
const originalActiveId = draft.getDoc().activeTimelineId;

// ── 1) validateHighlights 直测:越界/start>end/重叠都拒绝 ────────────────────
assert.strictEqual(validateHighlights({ nope: true }, 8, 5).length, 0, '非数组 → 空');
assert.strictEqual(
  validateHighlights([{ startWordIndex: -1, endWordIndex: 2 }, { startWordIndex: 5, endWordIndex: 99 }, { startWordIndex: 3, endWordIndex: 1 }], 8, 5).length,
  0, '越界与 start>end 全被丢弃',
);
const overlap = validateHighlights([{ startWordIndex: 0, endWordIndex: 3, title: 'a' }, { startWordIndex: 2, endWordIndex: 5, title: 'b' }], 8, 5);
assert.strictEqual(overlap.length, 1, '重叠段去重后只剩一条');
assert.deepStrictEqual([overlap[0].startWordIndex, overlap[0].endWordIndex], [0, 3], '保留先出现的区间');
assert.strictEqual(
  validateHighlights([{ startWordIndex: 0, endWordIndex: 0 }, { startWordIndex: 1, endWordIndex: 1 }, { startWordIndex: 2, endWordIndex: 2 }], 8, 2).length,
  2, 'max 上限生效',
);

// ── 2) 端到端(stub LLM):canned JSON 含一条越界项,应被拒绝而非崩溃 ──────────
setHighlightSelector(async () => [
  { startWordIndex: 0, endWordIndex: 1, title: '开场' },
  { startWordIndex: 0, endWordIndex: 99, title: '越界', reason: 'bad' }, // out-of-range → dropped, not a crash
  { startWordIndex: 2, endWordIndex: 6, title: '最精彩', reason: '高信息密度' },
]);

const res = await execHighlightTool('find_highlights', { count: 5, ratio: '9:16' }, ctx) as {
  ok: boolean; count: number; shorts: { timelineId: string; title: string; startFrame: number; endFrame: number; ratio: string }[];
};
assert.strictEqual(res.ok, true, '工具成功返回');
assert.strictEqual(res.shorts.length, 2, '3 条候选里越界的被剔除 → 2 条短视频');
assert.strictEqual(res.count, 2);

// 排序后:[0,1]=开场,[2,6]=最精彩
assert.deepStrictEqual(res.shorts.map((s) => s.title), ['开场', '最精彩']);
const hot = res.shorts[1];
assert.deepStrictEqual([hot.startFrame, hot.endFrame, hot.ratio], [30, 90, '9:16'], '高光帧区间来自词边界 ms×fps');

const doc = draft.getDoc();
assert.strictEqual(doc.activeTimelineId, originalActiveId, 'activate:false → 结束后视图回到原序列');
assert.strictEqual(doc.timelines.length, 3, '原序列 + 2 条短视频');

// 每条短视频都是 9:16 重定位后的画布(cover)
for (const s of res.shorts) {
  const tl = doc.timelines.find((t) => t.id === s.timelineId)!;
  assert.deepStrictEqual([tl.width, tl.height, tl.fit], [1080, 1920, 'cover'], `${s.title} 是竖屏 9:16 cover`);
}

// ── 3) 富样本(最精彩 [2,6]):裁剪只留高光段并保持词帧一致 ────────────────
const short = doc.timelines.find((t) => t.id === hot.timelineId)!;
const talk = short.items.find((it) => it.id === 'talk')!;

// 切点落在词边界,保留词的文本/时间戳一字未改;外侧词由 deletedWordIdx 标记。
assert.strictEqual(talk.transcript!.length, 8, '转写词一条不删(仅标记删除),词↔帧仍成对');
assert.deepStrictEqual([...(talk.deletedWordIdx ?? [])].sort((a, b) => a - b), [0, 1, 7], '高光外的词(0,1,7)被标记删除');
assert.strictEqual(talk.transcript![2].text, 'this', '保留词文本未改');
assert.strictEqual(talk.transcript![2].start, 1000, '保留词起点 ms 未改');
assert.strictEqual(talk.transcript![6].end, 3000, '保留词终点 ms 未改');
assert.deepStrictEqual(talk.transcript!.map((w) => w.text), words.map((w) => w.text), '任何词的文本都没被改写');
// 高光段被平移到 0,时长 = 帧区间跨度
assert.strictEqual(talk.startFrame, 0, '高光段起播帧对齐到 0');
assert.strictEqual(talk.durationInFrames, 60, 'clip 时长 = spanEnd-spanStart = 90-30');

// 其余 clip:交叠的 MG 被裁并平移;完全在区间外的 MG 被删
const ov = short.items.find((it) => it.id === 'ov')!;
assert.deepStrictEqual([ov.startFrame, ov.durationInFrames], [30, 30], '交叠 MG 裁到区间内并平移 -spanStart');
assert.strictEqual(short.items.find((it) => it.id === 'far'), undefined, '区间外 MG 被删除');
assert.strictEqual(short.items.length, 2, '短视频只剩高光跨度内的 clip');

// [0,1] 那条短视频:两条 MG 都在区间外 → 只剩口播
const opening = doc.timelines.find((t) => t.id === res.shorts[0].timelineId)!;
assert.strictEqual(opening.items.length, 1, '开场短视频只剩口播 clip');
assert.strictEqual(opening.items[0].durationInFrames, 30, '开场时长 = 前两词跨度');

// ── 4) 无转写 → 明确报错,不崩溃、不建序列 ──────────────────────────────────
const bareState: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: null, items: [{ id: 'v', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'v', kind: 'video', src: '/v.mp4' }] };
const bare = makeDraft(docFromTimeline(bareState));
const bareCtx: AgentContext = { commands: bare.commands, getState: bare.getState, getDoc: bare.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
const err = await execHighlightTool('find_highlights', { count: 3 }, bareCtx) as { error?: string };
assert.ok(err.error && /转写/.test(err.error), '无转写返回清晰错误');
assert.strictEqual(bare.getDoc().timelines.length, 1, '错误路径不新建任何序列');

setHighlightSelector(null); // 还原真 LLM 路径
console.log('highlight-tool.check: ok');
