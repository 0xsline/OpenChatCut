// remove_silence 的编辑规划器:把「源音频死气段」翻译成一串 split/remove 原子
// 动作(单次 batch = 一步撤销)。刻意只复用 split(转写分词、关键帧分段、淡入淡出
// 语义均由它处理)与 remove(同轨波纹闭合),不新增 reducer 动作。
import type { Action } from './reduce';
import type { TimelineItem } from './types';
import type { SilenceSpan } from '../audio/silence';

/** 切出来的段太碎没意义:静段间保留段短于此帧数时并入删除。 */
const MIN_KEEP_FRAMES = 6;
/** 静段短于此帧数不动手(帧域下限,叠加检测层的 minSilenceMs)。 */
const MIN_CUT_FRAMES = 2;

export interface PlannedRemoval {
  actions: Action[];
  /** 删掉的总帧数(时间线帧) */
  removedFrames: number;
  /** 实际动刀的段(clip 可视局部帧) */
  cuts: Array<{ fromFrame: number; toFrame: number }>;
}

/** 源毫秒死气段 → clip 可视局部帧段(clamp 到 clip 源窗口;贴边并小段)。 */
export function spansToLocalCuts(
  item: Pick<TimelineItem, 'durationInFrames' | 'srcInFrame'>,
  spans: readonly SilenceSpan[],
  fps: number,
): Array<{ fromFrame: number; toFrame: number }> {
  const srcIn = item.srcInFrame ?? 0;
  const clamped = spans
    .map((s) => ({
      fromFrame: Math.max(0, Math.round((s.startMs / 1000) * fps) - srcIn),
      toFrame: Math.min(item.durationInFrames, Math.round((s.endMs / 1000) * fps) - srcIn),
    }))
    .filter((c) => c.toFrame - c.fromFrame >= MIN_CUT_FRAMES)
    .sort((a, b) => a.fromFrame - b.fromFrame);
  // 相邻静段之间的保留段太碎 → 连同保留段一起删(合并区间)
  const merged: Array<{ fromFrame: number; toFrame: number }> = [];
  for (const cut of clamped) {
    const prev = merged[merged.length - 1];
    if (prev && cut.fromFrame - prev.toFrame < MIN_KEEP_FRAMES) prev.toFrame = Math.max(prev.toFrame, cut.toFrame);
    else merged.push({ ...cut });
  }
  // 头尾的碎保留段同样并入
  if (merged.length) {
    if (merged[0]!.fromFrame < MIN_KEEP_FRAMES) merged[0]!.fromFrame = 0;
    const last = merged[merged.length - 1]!;
    if (item.durationInFrames - last.toFrame < MIN_KEEP_FRAMES) last.toFrame = item.durationInFrames;
  }
  // 整条都被吞掉 = 检测层说"全是死气"却过了语音参照门 —— 不该发生,保守放弃
  if (merged.length === 1 && merged[0]!.fromFrame === 0 && merged[0]!.toFrame === item.durationInFrames) return [];
  return merged;
}

/**
 * 把死气段变成 split/remove 动作序列。动作按序应用(batch 语义):
 * split 的 atFrame 用「上一步之后」的时间线坐标,remove 的同轨波纹左移由本函数
 * 逐段补偿。newId 由调用方注入(浏览器 crypto.randomUUID;verify 里可确定性)。
 */
export function planSilenceRemoval(
  item: Pick<TimelineItem, 'id' | 'startFrame' | 'durationInFrames'>,
  cuts: ReadonlyArray<{ fromFrame: number; toFrame: number }>,
  makeId: () => string,
): PlannedRemoval {
  const actions: Action[] = [];
  const planned: Array<{ fromFrame: number; toFrame: number }> = [];
  let tailId = item.id; // 当前"尚未处理的右侧余段"的 id
  let tailStart = item.startFrame; // 该余段当前的时间线起点(随波纹左移更新)
  let tailLocal = 0; // 该余段起点对应的 clip 可视局部帧
  let removed = 0;

  for (const cut of cuts) {
    if (!tailId) break;
    const from = Math.max(cut.fromFrame, tailLocal);
    const to = Math.min(cut.toFrame, item.durationInFrames);
    if (to - from < MIN_CUT_FRAMES) continue;
    const cutsTail = to >= item.durationInFrames; // 静到 clip 结尾

    if (from <= tailLocal) {
      // 静段贴着余段开头:切一刀把静头分出去删掉
      if (cutsTail) {
        // 整个余段都是静的:直接删
        actions.push({ type: 'remove', ripple: true, id: tailId });
        planned.push({ fromFrame: from, toFrame: to });
        removed += to - from;
        tailId = '';
        break;
      }
      const restId = makeId();
      actions.push({ type: 'split', id: tailId, atFrame: tailStart + (to - tailLocal), newId: restId });
      actions.push({ type: 'remove', ripple: true, id: tailId });
      planned.push({ fromFrame: from, toFrame: to });
      removed += to - from;
      tailId = restId; // remove 波纹把 rest 拉回 tailStart
      tailLocal = to;
      continue;
    }

    // 静段在余段中间/结尾:先切出左侧保留段
    const silentId = makeId();
    actions.push({ type: 'split', id: tailId, atFrame: tailStart + (from - tailLocal), newId: silentId });
    if (cutsTail) {
      actions.push({ type: 'remove', ripple: true, id: silentId });
      planned.push({ fromFrame: from, toFrame: to });
      removed += to - from;
      tailId = '';
      break;
    }
    const restId = makeId();
    actions.push({ type: 'split', id: silentId, atFrame: tailStart + (from - tailLocal) + (to - from), newId: restId });
    actions.push({ type: 'remove', ripple: true, id: silentId });
    planned.push({ fromFrame: from, toFrame: to });
    removed += to - from;
    tailId = restId;
    tailStart = tailStart + (from - tailLocal); // rest 被波纹拉到静段原起点
    tailLocal = to;
  }

  return { actions, removedFrames: removed, cuts: planned };
}

/** remove_silence 不该碰的 clip:给出可读原因,工具层原样上报。 */
export function silenceRemovalBlocker(item: TimelineItem): string | null {
  if (item.kind !== 'video' && item.kind !== 'audio') return `kind=${item.kind} 无音频`;
  if (!item.src) return '无媒体源';
  if ((item.playbackRate ?? 1) !== 1) return '已变速(playbackRate≠1) — 先删静音再变速,或用 clean_script';
  if (item.zoom) return '带动画缩放(zoom) — 分段会打断缩放曲线,先移除 zoom';
  if (item.transcript?.length && (item.deletedWordIdx?.length || item.silenceFrames !== undefined || item.gapCapsMs)) {
    return '已有词级编辑/静音压缩 — 转写 clip 请用 clean_script 的静音上限(它按词间隙精确处理)';
  }
  return null;
}
