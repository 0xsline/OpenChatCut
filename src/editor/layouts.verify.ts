// Runnable check: `npx tsx src/editor/layouts.verify.ts`.
// Verification: Cover placement and inverse visible rectangle are exactly equal to the slots (all layouts × all slots); no stretching (scale single value is
// year-on-year); anchor boundary; fit mailbox; pip parameters; illegal slot rejection; tool layer verification and batch output.
import assert from 'node:assert/strict';
import {
  LAYOUT_IDS, layoutSlots, placeInSlot, visibleRectOf,
  type LayoutId, type SlotRect,
} from './layouts';
import { LAYOUT_TOOL_NAMES, execLayoutTool } from '../agent/tools/layout-tools';
import type { AgentContext } from '../agent/context';
import type { TimelineState } from './types';

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;
const rectNear = (a: SlotRect, b: SlotRect): boolean =>
  near(a.x, b.x, 1e-4) && near(a.y, b.y, 1e-4) && near(a.w, b.w, 1e-4) && near(a.h, b.h, 1e-4);

// ── cover: each layout, each slot, visible rectangle === slot (no overlap, no missing corners, no stretching) ──
for (const layout of LAYOUT_IDS) {
  const slots = layoutSlots(layout as LayoutId);
  for (const [name, slot] of Object.entries(slots)) {
    const t = placeInSlot(slot, 'cover');
    assert.ok(rectNear(visibleRectOf(t), slot), `${layout}/${name} cover 可视矩形应等于槽位`);
    assert.ok((t.scale ?? 0) > 0, `${layout}/${name} scale > 0`);
    const c = t.crop;
    if (c) {
      for (const v of [c.left, c.top, c.right, c.bottom]) assert.ok((v ?? 0) >= 0 && (v ?? 0) < 1, '裁切分数在界内');
      assert.ok((c.left ?? 0) + (c.right ?? 0) < 1 && (c.top ?? 0) + (c.bottom ?? 0) < 1, '裁切不吃光整层');
    }
  }
}

// ── Specific values: Left half screen = original size, middle half cropped, left shift 25%; grid angle = half size without cropping ──
const left = placeInSlot(layoutSlots('2up-horizontal').left!, 'cover');
assert.ok(near(left.scale!, 1) && near(left.x!, -25) && near(left.y!, 0), '左半屏 scale1/x-25');
assert.ok(near(left.crop!.left!, 0.25) && near(left.crop!.right!, 0.25), '左半屏左右各裁 1/4');
const tl = placeInSlot(layoutSlots('grid-4')['top-left']!, 'cover');
assert.equal(tl.crop, undefined, '同比槽(grid 角)无需裁切');
assert.ok(near(tl.scale!, 0.5) && near(tl.x!, -25) && near(tl.y!, -25), 'grid 角半尺寸居角');

// ── Anchor: 0 keeps left/top (left is not cropped), 1 keeps right/bottom; the visible rectangle is still exactly equal to the slot ──
const keepLeft = placeInSlot(layoutSlots('2up-horizontal').left!, 'cover', 0, 0.5);
assert.ok(near(keepLeft.crop!.left!, 0) && near(keepLeft.crop!.right!, 0.5), 'anchorX=0 只裁右侧');
assert.ok(rectNear(visibleRectOf(keepLeft), layoutSlots('2up-horizontal').left!), 'anchor 不破坏槽位对齐');
const keepBottom = placeInSlot(layoutSlots('2up-vertical').top!, 'cover', 0.5, 1);
assert.ok(near(keepBottom.crop!.top!, 0.5) && near(keepBottom.crop!.bottom!, 0), 'anchorY=1 只裁上侧');

// ── fit: The mailbox is not cut, the box is contained in the slot and centered ──
const fitLeft = placeInSlot(layoutSlots('2up-horizontal').left!, 'fit');
assert.equal(fitLeft.crop, undefined, 'fit 不裁切');
assert.ok(near(fitLeft.scale!, 0.5), 'fit 取 min(slot.w, slot.h)');
const fitBox = visibleRectOf(fitLeft);
const slotL = layoutSlots('2up-horizontal').left!;
assert.ok(fitBox.x >= slotL.x - 1e-6 && fitBox.x + fitBox.w <= slotL.x + slotL.w + 1e-6, 'fit 盒子横向含于槽');
assert.ok(near(fitBox.x + fitBox.w / 2, slotL.x + slotL.w / 2), 'fit 居中');

// ── full = reset:scale1 / no displacement / no cropping ──
const full = placeInSlot(layoutSlots('full').full!, 'cover');
assert.ok(near(full.scale!, 1) && near(full.x!, 0) && near(full.y!, 0) && full.crop === undefined && full.rotation === 0, 'full 即复位');

// ── pip: corner/size/margin parameters take effect and are clamped ──
const pip = layoutSlots('pip', { corner: 'top-left', size: 0.25, margin: 0.05 });
assert.ok(rectNear(pip.inset!, { x: 0.05, y: 0.05, w: 0.25, h: 0.25 }), 'pip 左上角小窗');
const clamped = layoutSlots('pip', { size: 5, margin: -1 });
assert.ok(near(clamped.inset!.w, 0.6) && near(clamped.inset!.x, 0.4), 'pip 参数越界被钳制');

// ──Illegal slot rejection──
assert.throws(() => placeInSlot({ x: 0.8, y: 0, w: 0.5, h: 1 }), /invalid slot/, '越出画布的槽拒绝');
assert.throws(() => placeInSlot({ x: 0, y: 0, w: 0, h: 1 }), /invalid slot/, '零宽槽拒绝');

// ── Tool layer: verification, batch output, pip stacking and time overlap reminder ──
assert.ok(LAYOUT_TOOL_NAMES.has('apply_layout'));
interface Recorded { actions: Array<{ type: string; id: string; patch: Record<string, unknown> }>; label?: string }
const recorded: Recorded = { actions: [] };
const state = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V2', 'V1'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } },
  items: [
    { id: 'a', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'A', kind: 'video', src: 'x.mp4' },
    { id: 'b', track: 'V2', startFrame: 30, durationInFrames: 90, name: 'B', kind: 'video', src: 'y.mp4' },
    { id: 'late', track: 'V2', startFrame: 500, durationInFrames: 30, name: 'L', kind: 'video', src: 'z.mp4' },
    { id: 'snd', track: 'V1', startFrame: 0, durationInFrames: 30, name: 'S', kind: 'audio', src: 's.mp3' },
  ],
} as unknown as TimelineState;
const ctx = {
  getState: () => state,
  commands: {
    batch: (actions: Recorded['actions'], label?: string) => { recorded.actions = actions; recorded.label = label; },
  },
} as unknown as AgentContext;

const ok = execLayoutTool('apply_layout', {
  layout: '2up-horizontal',
  assignments: [{ slot: 'left', itemId: 'a' }, { slot: 'right', itemId: 'b' }],
}, ctx) as { applied: Array<{ itemId: string; transform: { x?: number } }>; notes?: string[] };
assert.equal(recorded.actions.length, 2, '一次 batch 两条 setTransform');
assert.equal(recorded.actions[0]!.type, 'setTransform');
assert.ok(near(ok.applied[0]!.transform.x!, -25), '左槽 x=-25');
assert.equal(ok.notes, undefined, '时间重叠正常 → 无提醒');

const bad = execLayoutTool('apply_layout', { layout: 'grid-4', assignments: [{ slot: 'middle', itemId: 'a' }] }, ctx) as { error?: string };
assert.match(bad.error ?? '', /unknown slot/, '未知槽名报错');
const dup = execLayoutTool('apply_layout', { layout: '2up-horizontal', assignments: [{ slot: 'left', itemId: 'a' }, { slot: 'left', itemId: 'b' }] }, ctx) as { error?: string };
assert.match(dup.error ?? '', /assigned twice/, '重复槽报错');
const audio = execLayoutTool('apply_layout', { layout: 'full', assignments: [{ slot: 'full', itemId: 'snd' }] }, ctx) as { error?: string };
assert.match(audio.error ?? '', /visual clips/, '音频片段拒绝');

// trackOrder V2 in front (upstream) → inset V1 (downstream) should be reminded; if the time does not overlap, it should also be reminded
const warn = execLayoutTool('apply_layout', {
  layout: 'pip',
  assignments: [{ slot: 'main', itemId: 'b' }, { slot: 'inset', itemId: 'a' }],
}, ctx) as { notes?: string[] };
assert.ok(warn.notes?.some((n) => n.includes('BEHIND')), 'inset 低于 main → 叠放提醒');
const never = execLayoutTool('apply_layout', {
  layout: '2up-horizontal',
  assignments: [{ slot: 'left', itemId: 'a' }, { slot: 'right', itemId: 'late' }],
}, ctx) as { notes?: string[] };
assert.ok(never.notes?.some((n) => n.includes('overlap in time')), '时间不重叠 → 提醒');

console.log('layouts.verify: ok (cover 槽位恒等/anchor/fit/pip/复位/工具校验)');
