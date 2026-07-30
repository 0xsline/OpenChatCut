import type { AgentToolSchema } from '../../tool-schema';

export const MG_CODE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'create_motion_graphic_from_code',
    description: [
      'Create a new Motion Graphic asset from inline React/JSX code.',
      'Required: code, name, width, height. Duration via durationInFrames or durationInSeconds.',
      'The COMPLETE JSX must be in this single call — no declare-first-fill-later; a call without code is rejected.',
      'Code must pass the local MG sandbox (same as edit_asset). Does not auto-place on the timeline —',
      'use edit_item / add_motion_graphic / manage_media_pool to place after.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Inline Motion Graphic React/JSX. Not a file path.' },
        name: { type: 'string', description: 'Asset display name.' },
        width: { type: 'number', description: 'Natural box width in pixels.' },
        height: { type: 'number', description: 'Natural box height in pixels.' },
        durationInFrames: {
          type: 'number',
          description: 'Duration in timeline frames (mutually exclusive with durationInSeconds).',
        },
        durationInSeconds: {
          type: 'number',
          description: 'Duration in seconds (mutually exclusive with durationInFrames).',
        },
        description: { type: 'string', description: 'Optional human description (stored in props).' },
        properties: {
          type: 'array',
          description: 'Editable props: { key, label?, type?, defaultValue }[].',
          items: {},
        },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
      required: ['code', 'name', 'width', 'height'],
    },
  },
];

export const MG_CODE_TOOL_NAMES = new Set(MG_CODE_TOOL_SCHEMAS.map((t) => t.name));
