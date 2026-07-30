// change_cam 的编辑规划器:在切换区间 [fromFrame,toFrame) 内,把其他机位的
// 遮挡段翻译成 split/remove(无波纹)原子动作 —— 时间线其余部分完全不动。
// 刻意只复用 split(转写分词、关键帧分段、淡入淡出语义由它处理)与 remove,
// 不新增 reducer 动作;单次 batch = 一步撤销。
import type { Action } from './reduce';
import type { TimelineItem } from './types';

type Span = Pick<TimelineItem, 'id' | 'startFrame' | 'durationInFrames'>;

export interface CamSwitchPlan {
  actions: Action[];
  /** 被移除的其他机位段(时间线帧,右开) */
  removed: Array<{ itemId: string; fromFrame: number; toFrame: number }>;
  /** 区间内目标机位未覆盖的帧数(>0 = 该处会露出下层或黑场) */
  coverageGapFrames: number;
}

/** 目标机位各段在 [fromFrame,toFrame) 内覆盖的总帧数(段间不重叠;重叠时封顶区间长)。 */
export function coveredFrames(targets: readonly Span[], fromFrame: number, toFrame: number): number {
  let total = 0;
  for (const t of targets) {
    const a = Math.max(fromFrame, t.startFrame);
    const b = Math.min(toFrame, t.startFrame + t.durationInFrames);
    if (b > a) total += b - a;
  }
  return Math.min(total, Math.max(0, toFrame - fromFrame));
}

/**
 * 其他机位与区间相交的每个 clip:按需在区间边界切一到两刀,删掉区间内的段。
 * split 语义:左半保留原 id,右半得 newId(源点前移),因此先切左界再切右界,
 * 中段 id 始终可知。remove 不带 ripple —— 机位切换绝不能移动时间线。
 */
export function planCamSwitch(
  targets: readonly Span[],
  others: readonly Span[],
  fromFrame: number,
  toFrame: number,
  makeId: () => string,
): CamSwitchPlan {
  const actions: Action[] = [];
  const removed: CamSwitchPlan['removed'] = [];
  for (const o of others) {
    const end = o.startFrame + o.durationInFrames;
    const a = Math.max(fromFrame, o.startFrame);
    const b = Math.min(toFrame, end);
    if (b <= a) continue; // 不与切换区间相交
    let segId = o.id;
    if (a > o.startFrame) {
      const rightId = makeId();
      actions.push({ type: 'split', id: segId, atFrame: a, newId: rightId });
      segId = rightId; // 继续处理右半 [a,end)
    }
    if (b < end) {
      // 再切右界:segId 收窄为恰好 [a,b),新 id 是保留的尾段 [b,end)
      actions.push({ type: 'split', id: segId, atFrame: b, newId: makeId() });
    }
    actions.push({ type: 'remove', id: segId });
    removed.push({ itemId: o.id, fromFrame: a, toFrame: b });
  }
  return {
    actions,
    removed,
    coverageGapFrames: Math.max(0, toFrame - fromFrame) - coveredFrames(targets, fromFrame, toFrame),
  };
}
