import type { AgentToolSchema } from '../../tool-schema';
import { LAYOUT_IDS } from '../../../editor/layouts';

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
