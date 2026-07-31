import type { AgentToolSchema } from '../../tool-schema';

export const WATERMARK_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'update_watermark',
    description:
      'Toggle and configure a text watermark overlay on the active timeline. The watermark is a single label pinned to one corner, rendered in the preview and burned into every export. Pass only the fields you want to change (they merge over the current watermark). Set enabled:false to hide it without losing the text. To make it visible, enable it AND give it non-empty text.',
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Show (true) or hide (false) the watermark.' },
        text: { type: 'string', description: 'Watermark label text.' },
        position: { type: 'string', enum: ['tl', 'tr', 'bl', 'br'], description: 'Corner: tl=top-left, tr=top-right, bl=bottom-left, br=bottom-right.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Overlay opacity 0..1 (default 0.7).' },
      },
    },
  },
];

export const WATERMARK_TOOL_NAMES = new Set(WATERMARK_TOOL_SCHEMAS.map((t) => t.name));
