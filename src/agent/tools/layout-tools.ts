export { LAYOUT_TOOL_SCHEMAS, LAYOUT_TOOL_NAMES } from './schemas/layout-tools';
// apply_layout: Name the layout in one step (split screen/picture-in-picture/grid/reset).
// The tool calculates the scale/x/y/crop of each slot for the Agent (cover is not stretched), one batch = one step undo,
// Eliminate the cycle of "manually adjusting transform → view_timeline_frames screenshot alignment".
import type { AgentContext } from '../context';
import type { TimelineItem } from '../../editor/types';
import { timelineTrackIds, trackKind } from '../../editor/types';
import {
  LAYOUT_IDS, layoutSlots, placeInSlot,
  type LayoutId, type LayoutMode, type PipCorner,
} from '../../editor/layouts';

type Args = Record<string, unknown>;

/** The kind of the full canvas visual layer can be placed according to the slot (MG/text has its own box model, audio has no picture). */
const PLACEABLE_KINDS = new Set<TimelineItem['kind']>(['video', 'image', 'gif', 'svg']);

interface Assignment {
  slot: string;
  itemId: string;
}

function parseAssignments(raw: unknown, slots: Record<string, unknown>): Assignment[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'assignments must be a non-empty array' };
  const out: Assignment[] = [];
  const seenSlots = new Set<string>();
  const seenItems = new Set<string>();
  for (const entry of raw) {
    const slot = typeof (entry as Args)?.slot === 'string' ? String((entry as Args).slot) : '';
    const itemId = typeof (entry as Args)?.itemId === 'string' ? String((entry as Args).itemId) : '';
    if (!slot || !itemId) return { error: 'each assignment needs { slot, itemId }' };
    if (!(slot in slots)) return { error: `unknown slot "${slot}" — valid slots: ${Object.keys(slots).join(', ')}` };
    if (seenSlots.has(slot)) return { error: `slot "${slot}" assigned twice` };
    if (seenItems.has(itemId)) return { error: `item "${itemId}" assigned to two slots` };
    seenSlots.add(slot);
    seenItems.add(itemId);
    out.push({ slot, itemId });
  }
  return out;
}

export function execLayoutTool(name: string, args: Args, ctx: AgentContext): unknown {
  if (name !== 'apply_layout') return { error: `unknown tool ${name}` };
  const layout = String(args.layout ?? '') as LayoutId;
  if (!LAYOUT_IDS.includes(layout)) {
    return { error: `unknown layout "${args.layout}" — valid layouts: ${LAYOUT_IDS.join(', ')}` };
  }
  const slots = layoutSlots(layout, {
    corner: args.insetCorner as PipCorner | undefined,
    size: typeof args.insetSize === 'number' ? args.insetSize : undefined,
    margin: typeof args.insetMargin === 'number' ? args.insetMargin : undefined,
  });
  const assignments = parseAssignments(args.assignments, slots);
  if ('error' in assignments) return assignments;

  const mode: LayoutMode = args.mode === 'fit' ? 'fit' : 'cover';
  const anchorX = typeof args.anchorX === 'number' ? args.anchorX : 0.5;
  const anchorY = typeof args.anchorY === 'number' ? args.anchorY : 0.5;

  const state = ctx.getState();
  const items = new Map(state.items.map((it) => [it.id, it] as const));
  for (const { itemId } of assignments) {
    const item = items.get(itemId);
    if (!item) return { error: `item "${itemId}" not found on the active timeline` };
    if (!PLACEABLE_KINDS.has(item.kind)) {
      return { error: `item "${itemId}" is ${item.kind} — apply_layout places full-canvas visual clips (video/image/gif/svg) only` };
    }
  }

  const placed = assignments.map(({ slot, itemId }) => ({
    itemId,
    slot,
    transform: placeInSlot(slots[slot]!, mode, anchorX, anchorY),
  }));
  ctx.commands.batch(
    placed.map(({ itemId, transform }) => ({ type: 'setTransform' as const, id: itemId, patch: transform })),
    `应用布局 ${layout}`,
  );

  const notes: string[] = [];
  // Time overlap reminder: clips that do not appear at the same time and placed in the same layout are probably a misunderstanding.
  const spans = assignments.map(({ itemId }) => {
    const it = items.get(itemId)!;
    return [it.startFrame, it.startFrame + it.durationInFrames] as const;
  });
  const overlapFrom = Math.max(...spans.map(([from]) => from));
  const overlapTo = Math.min(...spans.map(([, to]) => to));
  if (assignments.length > 1 && overlapFrom >= overlapTo) {
    notes.push('assigned clips never overlap in time — they will not appear on screen together');
  }
  // pip stacking reminder: lines above the timeline are rendered on the upper layer, and inset must be higher than main.
  if (layout === 'pip') {
    const mainId = assignments.find((a) => a.slot === 'main')?.itemId;
    const insetId = assignments.find((a) => a.slot === 'inset')?.itemId;
    if (mainId && insetId) {
      const order = timelineTrackIds(state).filter((id) => trackKind(state, id) === 'video');
      const mainRow = order.indexOf(items.get(mainId)!.track);
      const insetRow = order.indexOf(items.get(insetId)!.track);
      if (mainRow >= 0 && insetRow >= 0 && insetRow >= mainRow) {
        notes.push('inset clip is not on a higher timeline row than main — it will render BEHIND the full-frame clip; move it to an upper video track');
      }
    }
  }

  return {
    layout,
    mode,
    applied: placed,
    ...(notes.length ? { notes } : {}),
    verify: 'view_timeline_frames on a frame where the clips overlap',
  };
}
