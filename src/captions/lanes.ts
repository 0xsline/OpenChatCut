// Multi-lane caption engine (pure logical rendering layer of edit_captions, no React):
// Parse sourceEntries into the rendering model of "Anchor Group → Lane Page".
// - auto-stack (default): stack up and down at the same position, list order = top → bottom, maxVisibleSources truncated
// - single-lane: Only 1 (or maxVisibleSources) item is displayed at the same position, priority/list order arbitration
// - manual-slots:slotId is nailed to the explicit slot; the entry with anchor is self-contained/merged into the anchor group
// Multiple sources with the same anchor will form a normal stacking block on the anchor point.
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

export type CaptionPlacementSource =
  | { kind: 'layout' }
  | { kind: 'entry'; sourceId: string }
  | { kind: 'slot'; slotId: string };

export interface LaneGroup {
  /** undefined anchor = the caption's shared block position (captions.layout) */
  anchor?: CaptionAnchor;
  offsetXRatio?: number;
  offsetYRatio?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  /** Every field whose mutation changes this rendered group's effective placement. */
  placementSources: CaptionPlacementSource[];
  /** lanes to render at this position, top-to-bottom */
  lanes: LanePage[];
}

const policyOf = (c: CaptionsData): CaptionLayoutPolicy =>
  c.layoutPolicy ?? { mode: 'auto-stack' };

interface ResolvedPlacement {
  layout?: Omit<LaneGroup, 'lanes' | 'placementSources'>;
  source: CaptionPlacementSource;
}

/** Effective placement source: slot → entry → shared layout, in renderer precedence order. */
function placementOf(entry: CaptionSourceEntry, policy: CaptionLayoutPolicy): ResolvedPlacement {
  if (policy.mode === 'manual-slots' && entry.slotId) {
    const slot = policy.slots.find((candidate) => candidate.id === entry.slotId);
    if (slot) {
      return {
        layout: { anchor: slot.anchor, offsetXRatio: slot.offsetXRatio, offsetYRatio: slot.offsetYRatio },
        source: { kind: 'slot', slotId: slot.id },
      };
    }
  }
  if (entry.anchor) {
    return {
      layout: {
        anchor: entry.anchor,
        offsetXRatio: entry.offsetXRatio,
        offsetYRatio: entry.offsetYRatio,
        scale: entry.scale,
        rotation: entry.rotation,
        opacity: entry.opacity,
      },
      source: { kind: 'entry', sourceId: entry.id },
    };
  }
  return { source: { kind: 'layout' } };
}

export interface EffectiveCaptionLaneGroup {
  layout?: Omit<LaneGroup, 'lanes' | 'placementSources'>;
  placementSources: CaptionPlacementSource[];
  entries: CaptionSourceEntry[];
}

const placementKey = (layout: ResolvedPlacement['layout']): string => layout?.anchor
  ? `${layout.anchor}|${layout.offsetXRatio ?? 0}|${layout.offsetYRatio ?? 0}|${layout.scale ?? 1}|${layout.rotation ?? 0}|${layout.opacity ?? 1}`
  : '__block__';

function samePlacementSource(left: CaptionPlacementSource, right: CaptionPlacementSource): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'layout') return true;
  if (left.kind === 'entry' && right.kind === 'entry') return left.sourceId === right.sourceId;
  return left.kind === 'slot' && right.kind === 'slot' && left.slotId === right.slotId;
}

/**
 * Pure policy resolver shared by rendering, QA, and avoidance. The input is
 * only the entries active at one instant, already in stable source order.
 */
export function resolveEffectiveCaptionLanes(
  captions: CaptionsData,
  activeEntries: readonly CaptionSourceEntry[],
): EffectiveCaptionLaneGroup[] {
  const policy = policyOf(captions);
  if (policy.mode === 'single-lane') {
    const cap = Math.max(1, policy.maxVisibleSources ?? 1);
    const picked = activeEntries
      .map((entry, order) => ({ entry, order }))
      .sort((a, b) => (a.entry.priority ?? a.order) - (b.entry.priority ?? b.order))
      .slice(0, cap)
      .map(({ entry }) => entry);
    return picked.length ? [{ placementSources: [{ kind: 'layout' }], entries: picked }] : [];
  }

  const cap = policy.mode === 'auto-stack' ? policy.maxVisibleSources : undefined;
  const visible = cap == null ? activeEntries : activeEntries.slice(0, Math.max(1, cap));
  const groups = new Map<string, EffectiveCaptionLaneGroup>();
  for (const entry of visible) {
    const placement = placementOf(entry, policy);
    const key = placementKey(placement.layout);
    let group = groups.get(key);
    if (!group) {
      group = { layout: placement.layout, placementSources: [], entries: [] };
      groups.set(key, group);
    }
    if (!group.placementSources.some((source) => samePlacementSource(source, placement.source))) {
      group.placementSources.push(placement.source);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

/** Lane rendering model of the current frame (ms). No sourceEntries → null (the caller takes the old single-stream path). */
export function buildLaneGroups(captions: CaptionsData, items: TimelineItem[], fps: number, ms: number, wordsPerPage: number | undefined): LaneGroup[] | null {
  const entries = captions.sourceEntries ? orderedCaptionSourceEntries(captions.sourceEntries) : undefined;
  if (!entries?.length) return null;
  // Each visible lane: word flow → paging → current page (lanes without active pages do not occupy this frame)
  const active: Array<{ entry: CaptionSourceEntry; lane: LanePage }> = [];
  entries.forEach((entry) => {
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
    active.push({ entry, lane: { entry, page, curIdx: currentWordIndex(page, ms) } });
  });
  if (!active.length) return [];

  const resolved = resolveEffectiveCaptionLanes(captions, active.map(({ entry }) => entry));
  const laneById = new Map(active.map(({ entry, lane }) => [entry.id, lane]));
  return resolved.map((group) => ({
    ...group.layout,
    placementSources: group.placementSources,
    lanes: group.entries.flatMap((entry) => {
      const lane = laneById.get(entry.id);
      return lane ? [lane] : [];
    }),
  }));
}
