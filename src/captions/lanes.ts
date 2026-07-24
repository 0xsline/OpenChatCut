// Multi-lane subtitle engine (pure logic rendering layer of edit_captions, no React):
// Parse sourceEntries into the rendering model of "Anchor Group → Lane Page".
// - auto-stack (default): stack up and down at the same position, list order = top → bottom, maxVisibleSources truncated
// - single-lane: Only 1 (or maxVisibleSources) item is displayed at the same position, priority/list order arbitration
// - manual-slots:slotId is nailed to the explicit slot; the entry with anchor is self-contained/merged into the anchor group
//   Multiple sources at the same anchor will form a normal stacked block on that anchor.
import type { CaptionAnchor, CaptionLayoutPolicy, CaptionPage, CaptionsData, CaptionSourceEntry } from './types';
import { activePage, currentWordIndex, paginate } from './types';
import type { TimelineItem } from '../editor/types';
import { resolveEntryWords } from './resolve';
import { orderedCaptionSourceEntries } from './sourceOrder';
import { isManualCaptionEntry } from './manualCaptions';

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

/** entry The landing point:manual-slots of slotId → Slot geometry;Otherwise entry own anchor;None → Shared blocks. */
function placementOf(entry: CaptionSourceEntry, policy: CaptionLayoutPolicy): { anchor?: CaptionAnchor; offsetXRatio?: number; offsetYRatio?: number } {
  if (policy.mode === 'manual-slots' && entry.slotId) {
    const slot = policy.slots.find((s) => s.id === entry.slotId);
    if (slot) return { anchor: slot.anchor, offsetXRatio: slot.offsetXRatio, offsetYRatio: slot.offsetYRatio };
  }
  if (entry.anchor) return { anchor: entry.anchor, offsetXRatio: entry.offsetXRatio, offsetYRatio: entry.offsetYRatio };
  return {};
}

/** current frame(ms)Lane rendering model. No sourceEntries → null(The caller takes the old path of single flow)。 */
export function buildLaneGroups(captions: CaptionsData, items: TimelineItem[], fps: number, ms: number, wordsPerPage: number | undefined): LaneGroup[] | null {
  const entries = captions.sourceEntries ? orderedCaptionSourceEntries(captions.sourceEntries) : undefined;
  if (!entries?.length) return null;
  const policy = policyOf(captions);

  // Each visible lane: word flow → paging → current page (lanes without active pages do not occupy this frame)
  const active: Array<{ entry: CaptionSourceEntry; lane: LanePage; order: number }> = [];
  entries.forEach((entry, order) => {
    if (entry.visible === false) return;
    const words = resolveEntryWords(entry, items, fps);
    if (!words.length) return;
    const maxLines = captions.perSource?.[entry.id]?.maxLines;
    const per = maxLines ? Math.max(1, (wordsPerPage ?? 6) * maxLines) : wordsPerPage;
    const manual = isManualCaptionEntry(entry);
    const pages = manual
      ? words.map((word) => ({ words: [word], start: word.start, end: word.end }))
      : paginate(words, captions.pacing, per);
    const page = manual
      ? [...pages].reverse().find((candidate) => ms >= candidate.start && ms < candidate.end) ?? null
      : activePage(pages, ms);
    if (!page) return;
    active.push({ entry, lane: { entry, page, curIdx: currentWordIndex(page, ms) }, order });
  });
  if (!active.length) return [];

  // single-lane: all fall in the shared block position, priority (default = list order) sorted and then truncated
  if (policy.mode === 'single-lane') {
    const cap = Math.max(1, policy.maxVisibleSources ?? 1);
    const picked = [...active]
      .sort((a, b) => (a.entry.priority ?? a.order) - (b.entry.priority ?? b.order))
      .slice(0, cap);
    return [{ lanes: picked.map((p) => p.lane) }];
  }

  // auto-stack / manual-slots: Group by drop point; same anchor point = same stacking block.
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
