// 改动型工具的时间线差分:工具跑完后直接告诉 agent「实际改了什么」,省掉一次
// 全量 read_project,也堵住「拿着过期坐标继续编辑」这类静默错误。
//
// 压缩是重点:一次波纹删除会推着同轨后面几十个片段整体左移,逐条列出来纯属噪声
// (还会挤爆上下文)。同轨同位移量的片段压成一条规则,只有零星几个才逐条列。
import {
  timelineTrackIds,
  trackAlias,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';

interface Placement {
  track: TrackId;
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineSnapshot {
  placements: Map<string, Placement>;
  trackIds: TrackId[];
}

/** 同轨同位移量达到这个数量才压成规则;不到就逐条列(更好读)。 */
const SHIFT_GROUP_MIN = 3;
/** 变更片段的枚举上限;超出只报总数并提示重读。 */
const MAX_CLIPS = 30;

const samePlace = (a: Placement, b: Placement): boolean =>
  a.track === b.track && a.startFrame === b.startFrame && a.durationInFrames === b.durationInFrames;

export function snapshotTimeline(state: TimelineState): TimelineSnapshot {
  const placements = new Map<string, Placement>();
  for (const it of state.items) {
    placements.set(it.id, {
      track: it.track,
      startFrame: it.startFrame,
      durationInFrames: it.durationInFrames,
    });
  }
  return { placements, trackIds: timelineTrackIds(state) };
}

/** 同轨、同位移量的一组片段:从 fromFrame 起 count 个各移动 by 帧。 */
export interface ShiftRule {
  track: string;
  fromFrame: number;
  by: number;
  count: number;
}

/** 变更片段的最小可用形状,字段名与 read_project 一致。 */
export interface DeltaClip {
  id: string;
  track: string;
  name: string;
  kind: TimelineItem['kind'];
  startFrame: number;
  durationInFrames: number;
}

export interface TimelineDelta {
  clips?: DeltaClip[];
  shifted?: ShiftRule[];
  removedItemIds?: string[];
  createdTracks?: string[];
  notes?: string[];
}

/**
 * 工具执行前后的时间线差分;什么都没变(只读工具)返回 null。
 * `before` 由 snapshotTimeline 在工具执行前取。
 */
export function describeTimelineDelta(
  before: TimelineSnapshot,
  state: TimelineState,
): TimelineDelta | null {
  const after = snapshotTimeline(state);
  const changed = new Set<string>();
  const shifts = new Map<string, { from: number; by: number }>();

  for (const [id, now] of after.placements) {
    const was = before.placements.get(id);
    if (!was) { changed.add(id); continue; }          // 新建
    if (samePlace(was, now)) continue;
    if (was.track === now.track && was.durationInFrames === now.durationInFrames) {
      shifts.set(id, { from: was.startFrame, by: now.startFrame - was.startFrame });
    } else {
      changed.add(id);                                 // 换轨 / 改长度 = 真变更
    }
  }

  // 同轨同位移量成组压缩;零星的退回逐条枚举
  const grouped = new Map<string, string[]>();
  for (const [id, shift] of shifts) {
    const key = `${after.placements.get(id)!.track}|${shift.by}`;
    grouped.set(key, [...(grouped.get(key) ?? []), id]);
  }
  const shifted: ShiftRule[] = [];
  for (const ids of grouped.values()) {
    if (ids.length < SHIFT_GROUP_MIN) { for (const id of ids) changed.add(id); continue; }
    shifted.push({
      track: trackAlias(state, after.placements.get(ids[0]!)!.track),
      fromFrame: Math.min(...ids.map((id) => shifts.get(id)!.from)),
      by: shifts.get(ids[0]!)!.by,
      count: ids.length,
    });
  }
  shifted.sort((a, b) => (a.track === b.track ? a.fromFrame - b.fromFrame : a.track.localeCompare(b.track)));

  const removedItemIds = [...before.placements.keys()].filter((id) => !after.placements.has(id)).sort();
  const beforeTracks = new Set(before.trackIds);
  const createdTracks = after.trackIds.filter((id) => !beforeTracks.has(id)).map((id) => trackAlias(state, id));

  const byId = new Map(state.items.map((it) => [it.id, it]));
  const allChanged = [...changed]
    .map((id) => byId.get(id))
    .filter((it): it is TimelineItem => !!it)
    .sort((a, b) => (a.track === b.track ? a.startFrame - b.startFrame : a.track.localeCompare(b.track)));

  const notes: string[] = [];
  const clips: DeltaClip[] = allChanged.slice(0, MAX_CLIPS).map((it) => ({
    id: it.id,
    track: trackAlias(state, it.track),
    name: it.name,
    kind: it.kind,
    startFrame: it.startFrame,
    durationInFrames: it.durationInFrames,
  }));
  if (allChanged.length > clips.length) {
    notes.push(`共 ${allChanged.length} 个片段变更,这里只列前 ${clips.length} 个;其余请重新读取时间线。`);
  }
  // 轨道数量变了 = 按别名/序号定位的旧结论可能失效
  if (createdTracks.length || after.trackIds.length !== before.trackIds.length) {
    notes.push('轨道构成已变化,按轨道定位前请重新确认。');
  }

  const delta: TimelineDelta = {};
  if (clips.length) delta.clips = clips;
  if (shifted.length) delta.shifted = shifted;
  if (removedItemIds.length) delta.removedItemIds = removedItemIds;
  if (createdTracks.length) delta.createdTracks = createdTracks;
  if (notes.length) delta.notes = notes;
  return Object.keys(delta).length ? delta : null;
}
