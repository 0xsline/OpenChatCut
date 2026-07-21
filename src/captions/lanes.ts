// 多车道字幕引擎(edit_captions 的纯逻辑渲染层，无 React):
// 把 sourceEntries 解析成"锚点组 → 车道页"的渲染模型。
// - auto-stack(默认):同一位置上下堆叠,列表序 = 上→下,maxVisibleSources 截断
// - single-lane:同一位置只显 1(或 maxVisibleSources)条,priority/列表序仲裁
// - manual-slots:slotId 钉到显式槽位;带 anchor 的 entry 自成/并入锚点组
//   相同 anchor 的多个 source 会组成该锚点上的普通堆叠块。
import type { CaptionAnchor, CaptionLayoutPolicy, CaptionPage, CaptionsData, CaptionSourceEntry } from './types';
import { activePage, currentWordIndex, paginate } from './types';
import type { TimelineItem } from '../editor/types';
import { resolveEntryWords } from './resolve';
import { orderedCaptionSourceEntries } from './sourceOrder';

export interface LanePage {
  entry: CaptionSourceEntry;
  page: CaptionPage;
  /** index of the word being spoken inside page.words (karaoke), -1 = none */
  curIdx: number;
}

export interface LaneGroup {
  /** undefined anchor = the caption's shared block position (captions.layout) */
  anchor?: CaptionAnchor;
  offsetXRatio?: number;
  offsetYRatio?: number;
  /** lanes to render at this position, top-to-bottom */
  lanes: LanePage[];
}

const policyOf = (c: CaptionsData): CaptionLayoutPolicy =>
  c.layoutPolicy ?? { mode: 'auto-stack' };

/** entry 的落点:manual-slots 的 slotId → 槽位几何;否则 entry 自己的 anchor;都无 → 共享块。 */
function placementOf(entry: CaptionSourceEntry, policy: CaptionLayoutPolicy): { anchor?: CaptionAnchor; offsetXRatio?: number; offsetYRatio?: number } {
  if (policy.mode === 'manual-slots' && entry.slotId) {
    const slot = policy.slots.find((s) => s.id === entry.slotId);
    if (slot) return { anchor: slot.anchor, offsetXRatio: slot.offsetXRatio, offsetYRatio: slot.offsetYRatio };
  }
  if (entry.anchor) return { anchor: entry.anchor, offsetXRatio: entry.offsetXRatio, offsetYRatio: entry.offsetYRatio };
  return {};
}

/** 当前帧(ms)的车道渲染模型。没有 sourceEntries → null(调用方走单流旧路径)。 */
export function buildLaneGroups(captions: CaptionsData, items: TimelineItem[], fps: number, ms: number, wordsPerPage: number | undefined): LaneGroup[] | null {
  const entries = captions.sourceEntries ? orderedCaptionSourceEntries(captions.sourceEntries) : undefined;
  if (!entries?.length) return null;
  const policy = policyOf(captions);

  // 每条可见车道:词流 → 分页 → 当前页(没有活动页的车道本帧不占位)
  const active: Array<{ entry: CaptionSourceEntry; lane: LanePage; order: number }> = [];
  entries.forEach((entry, order) => {
    if (entry.visible === false) return;
    const words = resolveEntryWords(entry, items, fps);
    if (!words.length) return;
    const maxLines = captions.perSource?.[entry.id]?.maxLines;
    const per = maxLines ? Math.max(1, (wordsPerPage ?? 6) * maxLines) : wordsPerPage;
    const pages = paginate(words, captions.pacing, per);
    const page = activePage(pages, ms);
    if (!page) return;
    active.push({ entry, lane: { entry, page, curIdx: currentWordIndex(page, ms) }, order });
  });
  if (!active.length) return [];

  // single-lane:全部落在共享块位置,priority(缺省=列表序)排序后截断
  if (policy.mode === 'single-lane') {
    const cap = Math.max(1, policy.maxVisibleSources ?? 1);
    const picked = [...active]
      .sort((a, b) => (a.entry.priority ?? a.order) - (b.entry.priority ?? b.order))
      .slice(0, cap);
    return [{ lanes: picked.map((p) => p.lane) }];
  }

  // auto-stack / manual-slots:按落点分组;同锚点 = 同一个堆叠块。
  const cap = policy.mode === 'auto-stack' ? policy.maxVisibleSources : undefined;
  const capped = cap != null ? active.slice(0, Math.max(1, cap)) : active;
  const groups = new Map<string, LaneGroup>();
  for (const { entry, lane } of capped) {
    const place = placementOf(entry, policy);
    const key = place.anchor ? `${place.anchor}|${place.offsetXRatio ?? 0}|${place.offsetYRatio ?? 0}` : '__block__';
    let g = groups.get(key);
    if (!g) { g = { ...place, lanes: [] }; groups.set(key, g); }
    g.lanes.push(lane);
  }
  return [...groups.values()];
}
