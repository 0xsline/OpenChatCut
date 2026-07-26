// 时长派生数据的自愈:片段长度一变,依附在长度上的数据必须跟着回到合法范围。
//
// 两条不变式:
//   1. 两侧淡化不能重叠 —— fadeIn + fadeOut ≤ durationInFrames。各自单独钳到全长
//      是不够的:100 帧的片段可以同时拿到 90 帧淡入和 90 帧淡出,fadeFactor 取两者
//      较小值,整段就一直是暗的。
//   2. 关键帧不能落在最后一帧之后 —— 那些帧永远渲染不到。
//
// retime / setSpeed / split / 删词压静音都会改 durationInFrames 却不管这两样,
// 所以修复放在 reduce 的出口统一做一遍,而不是在每个 case 里各加一道守卫:
// 少一个分支就少一个漏掉的地方,顺带把历史工程里已经存下的非法值一并自愈。
import { splitKeyframes } from './keyframes';
import type { ItemKeyframes, Keyframe, KeyframeProp, TimelineItem } from './types';

/** 淡化钳位:负数归零,再让出 `room` 给对侧。undefined 表示"没设过",保持不设。 */
export function capFade(value: number | undefined, room: number): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(value, Math.max(0, room)));
}

/**
 * 截到 0..last:复用 splitKeyframes 的左半边,它会在 `last` 上放一个精确的边界锚点
 * (贝塞尔段按 de Casteljau 细分),所以每个仍然渲染得到的帧采样值完全不变——直接
 * 丢掉尾部关键帧会让曲线提前停在上一个关键帧的值上。已经在范围内则原样返回。
 */
export function truncateKeyframes(kfs: readonly Keyframe[], last: number): Keyframe[] {
  const tail = kfs[kfs.length - 1];
  if (!tail || tail.frame <= last) return kfs as Keyframe[];
  return splitKeyframes(kfs, Math.max(0, last))[0];
}

/** 逐属性截断;全部都在范围内时返回原对象(保持引用相等)。 */
export function fitKeyframes(ik: ItemKeyframes | undefined, last: number): ItemKeyframes | undefined {
  if (!ik) return ik;
  let changed = false;
  const out: ItemKeyframes = {};
  for (const [prop, kfs] of Object.entries(ik) as [KeyframeProp, Keyframe[]][]) {
    if (!kfs?.length) continue;
    const next = truncateKeyframes(kfs, last);
    if (next !== kfs) changed = true;
    out[prop] = next;
  }
  if (!changed) return ik;
  return Object.keys(out).length ? out : undefined;
}

type FitTarget = Pick<TimelineItem, 'durationInFrames' | 'fadeInFrames' | 'fadeOutFrames' | 'keyframes'>;

/**
 * 把单个片段的淡化与关键帧压回当前时长。没有任何越界时返回原片段本身,
 * 让 reduce 出口的全量扫描在常见情况下不产生新对象、不触发多余重渲染。
 */
export function fitItemToDuration<T extends FitTarget>(item: T): T {
  const duration = Math.max(1, item.durationInFrames);
  // fadeIn 先钳到全长,fadeOut 再吃掉剩下的空间:这是"修复"路径,没有哪一侧是
  // 用户当下正在编辑的,所以固定优先级即可(setFade 里另有"被编辑侧让位"的规则)。
  const fadeInFrames = capFade(item.fadeInFrames, duration);
  const fadeOutFrames = capFade(item.fadeOutFrames, duration - (fadeInFrames ?? 0));
  const keyframes = fitKeyframes(item.keyframes, duration - 1);
  if (
    fadeInFrames === item.fadeInFrames
    && fadeOutFrames === item.fadeOutFrames
    && keyframes === item.keyframes
  ) {
    return item;
  }
  return { ...item, fadeInFrames, fadeOutFrames, keyframes };
}

/**
 * 把一条时间线里所有片段压回各自时长。全部合法时返回原对象(引用相等),
 * 所以放在 reduce 出口逐动作跑不会引起多余重渲染。
 *
 * 加载工程时也要跑一遍:reduce 只在有动作时才走到,历史工程里已经存下的非法淡化
 * 光靠它修不到——用户得先动一下那个片段才会变正常。
 */
export function fitTimelineItems<T extends { items: TimelineItem[] }>(timeline: T): T {
  let changed = false;
  const items = timeline.items.map((it) => {
    const next = fitItemToDuration(it);
    if (next !== it) changed = true;
    return next;
  });
  return changed ? { ...timeline, items } : timeline;
}
