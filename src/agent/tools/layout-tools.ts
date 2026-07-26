// apply_layout:命名布局一步摆位(分屏/画中画/网格/复位)。
// 工具替 Agent 算好每个槽位的 scale/x/y/crop(cover 不拉伸),一次 batch = 一步撤销,
// 免去"手调 transform → view_timeline_frames 截图对齐"的循环。
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { TimelineItem } from '../../editor/types';
import { timelineTrackIds, trackKind } from '../../editor/types';
import {
  LAYOUT_IDS, layoutSlots, placeInSlot,
  type LayoutId, type LayoutMode, type PipCorner,
} from '../../editor/layouts';

type Args = Record<string, unknown>;

/** 全画布可视层的 kind 才能按槽位摆(MG/text 有自己的盒模型,音频无画面)。 */
const PLACEABLE_KINDS = new Set<TimelineItem['kind']>(['video', 'image', 'gif', 'svg']);

export const LAYOUT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'apply_layout',
    description: [
      'Arrange visual clips into a named multi-video layout (split screen / picture-in-picture / grid) in ONE undoable step.',
      'You pick a layout and assign a clip to each slot; the tool computes scale/position/crop so each clip FILLS its slot',
      'edge-to-edge WITHOUT stretching (mode=cover crops the layer; anchorX/anchorY 0..1 choose which side to keep, default center).',
      'mode=fit letterboxes instead of cropping. layout=full resets one clip back to full frame (clears layout crop/scale).',
      'Layouts and slots: full(full) · 2up-horizontal(left,right) · 2up-vertical(top,bottom) · 3up-horizontal(left,center,right)',
      '· grid-4(top-left,top-right,bottom-left,bottom-right) · pip(main,inset; insetCorner/insetSize/insetMargin tune the small window).',
      'Fewer assignments than slots is fine (other slots stay empty). Stacking follows track order (upper timeline row renders on top),',
      'so put the pip inset clip on a HIGHER row than main — the result notes when it is not. Clips must overlap in time to be seen together.',
      'Works on the canvas layer: with timeline fit=contain, a source whose aspect differs from the canvas keeps its own letterbox inside the slot.',
      'After applying, verify with view_timeline_frames.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: [...LAYOUT_IDS], description: 'Named layout to apply.' },
        assignments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              slot: { type: 'string', description: 'Slot name of the chosen layout (e.g. "left", "inset").' },
              itemId: { type: 'string', description: 'Visual timeline item id (video/image/gif/svg) to place in the slot.' },
            },
            required: ['slot', 'itemId'],
          },
          description: 'One entry per slot to fill. Slots and items must be unique within the call.',
        },
        mode: { type: 'string', enum: ['cover', 'fit'], description: 'cover (default) crops to fill the slot; fit letterboxes.' },
        anchorX: { type: 'number', minimum: 0, maximum: 1, description: 'cover only: horizontal keep-side, 0=left 0.5=center(default) 1=right.' },
        anchorY: { type: 'number', minimum: 0, maximum: 1, description: 'cover only: vertical keep-side, 0=top 0.5=center(default) 1=bottom.' },
        insetCorner: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], description: 'pip only: small-window corner (default bottom-right).' },
        insetSize: { type: 'number', minimum: 0.1, maximum: 0.6, description: 'pip only: small-window size as canvas fraction (default 0.3).' },
        insetMargin: { type: 'number', minimum: 0, maximum: 0.2, description: 'pip only: gap to the canvas edge (default 0.04).' },
      },
      required: ['layout', 'assignments'],
    },
  },
];

export const LAYOUT_TOOL_NAMES = new Set(LAYOUT_TOOL_SCHEMAS.map((t) => t.name));

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
  // 时间重叠提醒:不同时出现的 clip 摆同一布局多半是误会。
  const spans = assignments.map(({ itemId }) => {
    const it = items.get(itemId)!;
    return [it.startFrame, it.startFrame + it.durationInFrames] as const;
  });
  const overlapFrom = Math.max(...spans.map(([from]) => from));
  const overlapTo = Math.min(...spans.map(([, to]) => to));
  if (assignments.length > 1 && overlapFrom >= overlapTo) {
    notes.push('assigned clips never overlap in time — they will not appear on screen together');
  }
  // pip 叠放提醒:时间线上方的行渲染在上层,inset 必须比 main 更靠上。
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
