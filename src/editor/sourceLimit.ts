// 片段不能比它的源素材更长。
//
// 左侧裁剪一直有 srcInFrame 兜底(入点不能为负),右侧却完全没有上界:把右手柄
// 往外拖可以拉出比素材还长的片段,超出的部分只是定格在最后一帧。上界由 reduce 的
// retime 统一执行——指针拖拽和 agent 的裁剪工具都汇到那一条路上。
import type { MediaAsset, TimelineItem } from './types';

type SourceItem = Pick<TimelineItem, 'kind' | 'src' | 'playbackRate' | 'transcript'>;

/**
 * 从 `srcInFrame` 出发还能播多少条时间线帧;判定不了长度就返回 null(不设限)。
 *
 * 只对真实文件媒体(video/audio)生效:图片、MG、文字、纯色本来就可以任意拉长。
 * 词驱动音频(audio + transcript)由 retime 自己按编辑后词流长度收口,不走这里,
 * 否则两套上界会打架。playbackRate 换算:时间线帧 = 源帧 / rate。
 */
export function remainingSourceFrames(
  item: SourceItem,
  srcInFrame: number,
  assets: readonly MediaAsset[] | undefined,
): number | null {
  if (item.kind !== 'video' && item.kind !== 'audio') return null;
  if (item.kind === 'audio' && item.transcript?.length) return null;
  if (!item.src || !assets?.length) return null;
  const total = assets.find((asset) => asset.src === item.src)?.durationInFrames ?? 0;
  if (!(total > 0)) return null;
  const rate = Math.max(0.01, item.playbackRate ?? 1);
  return Math.max(1, Math.floor((total - Math.max(0, srcInFrame)) / rate));
}
