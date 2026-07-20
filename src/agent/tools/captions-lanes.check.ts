// 多车道字幕三兄弟检查:npx tsx src/agent/tools/captions-lanes.check.ts
// ① lanes.ts 引擎(auto-stack/single-lane/manual-slots/positions 分组语义)
// ② ensureEntries 提升 ③ matchEntries 选择器 ④ 三个 action 的写入与校验
import assert from 'node:assert/strict';
import type { CaptionsData, CaptionSourceEntry } from '../../captions/types';
import { buildLaneGroups } from '../../captions/lanes';
import type { TimelineItem, TimelineState } from '../../editor/types';
import type { AgentContext } from '../context';
import { ensureEntries, matchEntries, execLayoutPolicy, execPositions, execSourceUpdate } from './captions-lanes';

// fps=1000 → ms 即帧。两条转写 audio:a 说 0-200ms,b 说 50-250ms(重叠期两车道同时活跃)。
const itemA: TimelineItem = {
  id: 'a', kind: 'audio', name: 'voA', track: 'A1', startFrame: 0, durationInFrames: 200,
  transcript: [{ text: 'hi', start: 0, end: 100 }, { text: 'there', start: 100, end: 200 }],
} as TimelineItem;
const itemB: TimelineItem = {
  id: 'b', kind: 'audio', name: 'voB', track: 'A2', startFrame: 0, durationInFrames: 250,
  transcript: [{ text: 'yo', start: 50, end: 150 }, { text: 'friend', start: 150, end: 250 }],
} as TimelineItem;
const S: TimelineState = { fps: 1000, width: 1920, height: 1080, selectedId: null, items: [itemA, itemB] } as TimelineState;

const entries2: CaptionSourceEntry[] = [{ id: 's1', itemId: 'a' }, { id: 's2', itemId: 'b' }];
const cap = (over: Partial<CaptionsData>): CaptionsData =>
  ({ enabled: true, template: 'plain', pacing: 'word', sourceEntries: entries2, ...over }) as CaptionsData;

// ── 引擎:默认 auto-stack,同一共享块上下堆叠(列表序 = 上→下)──────────────
{
  const groups = buildLaneGroups(cap({}), S.items, S.fps, 60, 6)!;
  assert.equal(groups.length, 1, '无 anchor → 一个共享块组');
  assert.equal(groups[0].anchor, undefined);
  assert.deepEqual(groups[0].lanes.map((l) => l.entry.id), ['s1', 's2'], '列表序渲染,第一个在最上');
  assert.deepEqual(groups[0].lanes.map((l) => l.page.words[0].text), ['hi', 'yo']);
}
// maxVisibleSources=1 截断
{
  const groups = buildLaneGroups(cap({ layoutPolicy: { mode: 'auto-stack', maxVisibleSources: 1 } }), S.items, S.fps, 60, 6)!;
  assert.deepEqual(groups[0].lanes.map((l) => l.entry.id), ['s1']);
}
// single-lane:默认只显 1 条;priority 小者优先
{
  const g1 = buildLaneGroups(cap({ layoutPolicy: { mode: 'single-lane' } }), S.items, S.fps, 60, 6)!;
  assert.deepEqual(g1[0].lanes.map((l) => l.entry.id), ['s1'], '缺省按列表序');
  const withPrio: CaptionSourceEntry[] = [{ id: 's1', itemId: 'a', priority: 5 }, { id: 's2', itemId: 'b', priority: 0 }];
  const g2 = buildLaneGroups(cap({ sourceEntries: withPrio, layoutPolicy: { mode: 'single-lane' } }), S.items, S.fps, 60, 6)!;
  assert.deepEqual(g2[0].lanes.map((l) => l.entry.id), ['s2'], 'priority 仲裁');
}
// per-entry anchor:不同锚点分组;相同锚点合成一个堆叠块。
{
  const placed: CaptionSourceEntry[] = [
    { id: 's1', itemId: 'a', anchor: 'top-center', offsetYRatio: 0.08 },
    { id: 's2', itemId: 'b', anchor: 'bottom-center', offsetYRatio: -0.08 },
  ];
  const groups = buildLaneGroups(cap({ sourceEntries: placed }), S.items, S.fps, 60, 6)!;
  assert.equal(groups.length, 2, '两个锚点 → 两组');
  const sameAnchor = placed.map((e) => ({ ...e, anchor: 'top-center' as const, offsetYRatio: 0.08 }));
  const merged = buildLaneGroups(cap({ sourceEntries: sameAnchor }), S.items, S.fps, 60, 6)!;
  assert.equal(merged.length, 1, '同锚点 → 同一个堆叠块');
  assert.equal(merged[0].lanes.length, 2);
}
// manual-slots:slotId 钉槽位
{
  const pinned: CaptionSourceEntry[] = [{ id: 's1', itemId: 'a', slotId: 'top' }, { id: 's2', itemId: 'b', slotId: 'bottom' }];
  const groups = buildLaneGroups(cap({
    sourceEntries: pinned,
    layoutPolicy: { mode: 'manual-slots', slots: [{ id: 'top', anchor: 'top-center', offsetYRatio: 0.08 }, { id: 'bottom', anchor: 'bottom-center', offsetYRatio: -0.08 }] },
  }), S.items, S.fps, 60, 6)!;
  assert.deepEqual(groups.map((g) => g.anchor).sort(), ['bottom-center', 'top-center']);
}
// 不可见车道不渲染;无 sourceEntries → null(单流旧路径)
{
  const hidden: CaptionSourceEntry[] = [{ id: 's1', itemId: 'a', visible: false }, { id: 's2', itemId: 'b' }];
  const groups = buildLaneGroups(cap({ sourceEntries: hidden }), S.items, S.fps, 60, 6)!;
  assert.deepEqual(groups[0].lanes.map((l) => l.entry.id), ['s2']);
  assert.equal(buildLaneGroups(cap({ sourceEntries: undefined }), S.items, S.fps, 60, 6), null);
}

// ── ensureEntries 提升 + matchEntries 选择器 ────────────────────────────────
{
  const fromItem = ensureEntries({ enabled: true, template: 'plain', pacing: 'word', sourceItemId: 'a' } as CaptionsData, S);
  assert.equal(fromItem.length, 1);
  assert.equal(fromItem[0].itemId, 'a');
  const fromLegacy = ensureEntries({ enabled: true, template: 'plain', pacing: 'word', sources: ['a', 'b'] } as CaptionsData, S);
  assert.deepEqual(fromLegacy.map((e) => e.itemId), ['a', 'b']);
  const fromTimeline = ensureEntries({ enabled: true, template: 'plain', pacing: 'word', sourceMode: 'timeline' } as CaptionsData, S);
  assert.deepEqual(fromTimeline.map((e) => e.itemId), ['a', 'b']);
}
{
  assert.deepEqual(matchEntries(entries2, { index: 1 }, S), [1]);
  assert.deepEqual(matchEntries(entries2, { sourceId: 's2' }, S), [1]);
  assert.deepEqual(matchEntries(entries2, { trackId: 'A2' }, S), [1]);
  assert.deepEqual(matchEntries(entries2, { itemId: 'a' }, S), [0]);
  const err = matchEntries(entries2, { speakerId: 'sp1' }, S);
  assert.ok('error' in (err as object), 'speakerId → 显式不支持');
  const miss = matchEntries(entries2, { label: 'nope' }, S);
  assert.ok('error' in (miss as object));
}

// ── action 层(mock ctx 捕获 updateCaptions patch)──────────────────────────
let lastPatch: Partial<CaptionsData> | null = null;
const ctx = { commands: { updateCaptions: (p: Partial<CaptionsData>) => { lastPatch = p; } } } as unknown as AgentContext;

// positions:摆两条车道;anchor 校验;写入 sourceEntries
{
  lastPatch = null;
  const r = execPositions({ positions: [
    { index: 0, anchor: 'bottom-center', offsetYRatio: -0.08 },
    { index: 1, anchor: 'top-center', offsetYRatio: 0.08 },
  ] }, cap({}), ctx, S);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(lastPatch!.sourceEntries![0].anchor, 'bottom-center');
  assert.equal(lastPatch!.sourceEntries![1].anchor, 'top-center');
  const bad = execPositions({ positions: [{ index: 0, anchor: 'nowhere' }] }, cap({}), ctx, S);
  assert.ok(bad.error, 'anchor 非法要报错');
}
// layout_policy:三模式 + perSource + 清除 + 校验
{
  lastPatch = null;
  const r = execLayoutPolicy({ mode: 'auto-stack', maxVisibleSources: 2 }, cap({}), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(lastPatch!.layoutPolicy, { mode: 'auto-stack', maxVisibleSources: 2 });
  const slots = execLayoutPolicy({ mode: 'manual-slots', slots: [{ id: 'top', anchor: 'top-center' }] }, cap({}), ctx);
  assert.equal(slots.ok, true);
  const noSlots = execLayoutPolicy({ mode: 'manual-slots' }, cap({}), ctx);
  assert.ok(noSlots.error);
  const badMode = execLayoutPolicy({ mode: 'diagonal' }, cap({}), ctx);
  assert.ok(badMode.error);
  lastPatch = null;
  const per = execLayoutPolicy({ perSource: { s2: { maxLines: 2 } } }, cap({}), ctx);
  assert.equal(per.ok, true);
  assert.deepEqual(lastPatch!.perSource, { s2: { maxLines: 2 } });
  lastPatch = null;
  const clear = execLayoutPolicy({ layoutPolicy: null }, cap({}), ctx);
  assert.equal(clear.ok, true);
  assert.equal(lastPatch!.layoutPolicy, null);
}
// source_update:visible/anchor/style(sizePx→fontSize 比例)/variant 校验
{
  lastPatch = null;
  const r = execSourceUpdate({ updates: [
    { trackId: 'A2', anchor: 'top-center', offsetYRatio: 0.08, style: { sizePx: 54, color: '#fff' } },
    { index: 0, visible: false },
  ] }, cap({}), ctx, S);
  assert.equal(r.ok, true, JSON.stringify(r));
  const es = lastPatch!.sourceEntries!;
  assert.equal(es[1].anchor, 'top-center');
  assert.ok(Math.abs((es[1].style!.fontSize ?? 0) - 54 / 1080) < 1e-9, 'sizePx → fontSize 比例(canvasHeight)');
  assert.equal(es[1].style!.color, '#fff');
  assert.equal(es[0].visible, false);
  const noVar = execSourceUpdate({ updates: [{ index: 0, languageCode: 'en' }] }, cap({}), ctx, S);
  assert.ok(noVar.error, '无翻译变体时 variant 切换要报错(先 translation_ensure)');
}

console.log('captions-lanes.check: ok (引擎 6 组语义 / 提升 / 选择器 / 三 action 写入+校验)');
