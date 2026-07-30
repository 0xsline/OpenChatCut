// 命名布局(分屏/画中画/网格/复位):把多个可视 clip 一步摆进画布槽位。
// 槽位矩形用画布分数表示;放置计算只产出既有 ClipTransform 字段
// (scale/x/y/rotation/crop),渲染层零新增能力。cover 数学依赖两个既有事实:
//   ① 可视层恒为整画布尺寸(MediaFill width/height 100%);
//   ② ClipWrapper 的 clip-path inset 先裁层,translate/rotate/scale 再整体移动,
//      且 translate% 以未变换层(=画布)尺寸为基、scale 围绕层中心。
import type { ClipCrop, ClipTransform } from './types';

/** 画布分数矩形:x/y 为左上角,w/h 为尺寸,均 0..1。 */
export interface SlotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutMode = 'cover' | 'fit';
export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface PipOptions {
  corner?: PipCorner;
  /** 小窗边长(画布分数)。默认 0.3,钳到 0.1..0.6。 */
  size?: number;
  /** 小窗到画布边缘的留白(画布分数)。默认 0.04,钳到 0..0.2。 */
  margin?: number;
}

export const LAYOUT_IDS = ['full', '2up-horizontal', '2up-vertical', '3up-horizontal', 'grid-4', 'pip'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const STATIC_SLOTS: Record<Exclude<LayoutId, 'pip'>, Record<string, SlotRect>> = {
  full: { full: { x: 0, y: 0, w: 1, h: 1 } },
  '2up-horizontal': {
    left: { x: 0, y: 0, w: 0.5, h: 1 },
    right: { x: 0.5, y: 0, w: 0.5, h: 1 },
  },
  '2up-vertical': {
    top: { x: 0, y: 0, w: 1, h: 0.5 },
    bottom: { x: 0, y: 0.5, w: 1, h: 0.5 },
  },
  '3up-horizontal': {
    left: { x: 0, y: 0, w: 1 / 3, h: 1 },
    center: { x: 1 / 3, y: 0, w: 1 / 3, h: 1 },
    right: { x: 2 / 3, y: 0, w: 1 / 3, h: 1 },
  },
  'grid-4': {
    'top-left': { x: 0, y: 0, w: 0.5, h: 0.5 },
    'top-right': { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    'bottom-left': { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    'bottom-right': { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  },
};

/** 布局 → 槽位表(pip 由参数生成:main 全幅 + inset 角上小窗)。 */
export function layoutSlots(layout: LayoutId, pip?: PipOptions): Record<string, SlotRect> {
  if (layout !== 'pip') return STATIC_SLOTS[layout];
  const size = clamp(pip?.size ?? 0.3, 0.1, 0.6);
  const margin = clamp(pip?.margin ?? 0.04, 0, 0.2);
  const corner = pip?.corner ?? 'bottom-right';
  const x = corner === 'top-left' || corner === 'bottom-left' ? margin : 1 - margin - size;
  const y = corner === 'top-left' || corner === 'top-right' ? margin : 1 - margin - size;
  return {
    main: { x: 0, y: 0, w: 1, h: 1 },
    inset: { x, y, w: size, h: size },
  };
}

/**
 * 计算把一个可视层放进槽位的 ClipTransform。
 * cover:裁层到与槽同比(不拉伸、无信箱),anchor 决定保留源画面的哪一侧
 * (0=左/上,0.5=居中,1=右/下)。fit:整层信箱式缩进槽内,不裁切。
 * 产出总是完整覆盖 scale/x/y/rotation/crop 五个字段(rotation 归 0、无裁切时
 * crop 显式 undefined),配合 setTransform 的浅合并即可清掉旧布局残留。
 */
export function placeInSlot(
  slot: SlotRect,
  mode: LayoutMode = 'cover',
  anchorX = 0.5,
  anchorY = 0.5,
): ClipTransform {
  if (!(slot.w > 0) || !(slot.h > 0) || slot.w > 1 || slot.h > 1
    || slot.x < 0 || slot.y < 0 || slot.x + slot.w > 1 + 1e-9 || slot.y + slot.h > 1 + 1e-9) {
    throw new Error(`invalid slot rect: ${JSON.stringify(slot)}`);
  }
  const slotCx = slot.x + slot.w / 2;
  const slotCy = slot.y + slot.h / 2;

  if (mode === 'fit') {
    const scale = Math.min(slot.w, slot.h);
    return {
      scale: round(scale, 6),
      x: round((slotCx - 0.5) * 100, 4),
      y: round((slotCy - 0.5) * 100, 4),
      rotation: 0,
      crop: undefined,
    };
  }

  // cover:可视窗 wf×hf 与槽同比且最大化(至少一边吃满整层),缩放即恰好铺满槽。
  const wide = slot.w >= slot.h;
  const wf = wide ? 1 : slot.w / slot.h;
  const hf = wide ? slot.h / slot.w : 1;
  const scale = slot.w / wf; // === slot.h / hf(同比构造保证等值 → 无拉伸)
  const ax = clamp(anchorX, 0, 1);
  const ay = clamp(anchorY, 0, 1);
  const left = (1 - wf) * ax;
  const top = (1 - hf) * ay;
  // 裁后可视中心(层坐标分数);scale 围绕层中心,translate 再以画布分数补位。
  const cx = left + wf / 2;
  const cy = top + hf / 2;
  const tx = slotCx - (0.5 + (cx - 0.5) * scale);
  const ty = slotCy - (0.5 + (cy - 0.5) * scale);
  const crop: ClipCrop | undefined = wf < 1 || hf < 1
    ? {
      left: round(left, 6),
      top: round(top, 6),
      right: round(1 - wf - left, 6),
      bottom: round(1 - hf - top, 6),
    }
    : undefined;
  return {
    scale: round(scale, 6),
    x: round(tx * 100, 4),
    y: round(ty * 100, 4),
    rotation: 0,
    crop,
  };
}

/** 由放置结果反推屏上可视矩形(画布分数)——供校验:cover 模式应恰等于槽。 */
export function visibleRectOf(t: ClipTransform): SlotRect {
  const left = t.crop?.left ?? 0;
  const top = t.crop?.top ?? 0;
  const wf = 1 - left - (t.crop?.right ?? 0);
  const hf = 1 - top - (t.crop?.bottom ?? 0);
  const scale = t.scale ?? 1;
  const cx = 0.5 + (left + wf / 2 - 0.5) * scale + (t.x ?? 0) / 100;
  const cy = 0.5 + (top + hf / 2 - 0.5) * scale + (t.y ?? 0) / 100;
  return { x: cx - (wf * scale) / 2, y: cy - (hf * scale) / 2, w: wf * scale, h: hf * scale };
}
