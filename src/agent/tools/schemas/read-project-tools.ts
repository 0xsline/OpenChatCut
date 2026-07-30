import type { AgentToolSchema } from '../../tool-schema';

export const READ_PROJECT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_project',
    description: [
      'View the project — tracks, timeline items, markers, media-pool folders, assets, and explicit offline-media status.',
      'Default = full overview. Narrow with view:"timeline"|"assets", timelineId, track, fromFrame/toFrame, itemId, assetId.',
      'Pass code:true with assetId to include MG source code.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['timeline', 'assets'],
          description: "'timeline' tracks+items+markers; 'assets' library only. Omit for full overview.",
        },
        timelineId: { type: 'string', description: 'Inspect a non-active timeline by id/prefix without switching.' },
        track: { type: 'string', description: 'Filter by track alias (e.g. C1, V1, A1).' },
        fromFrame: { type: 'number', description: 'Items overlapping this frame or later (half-open with toFrame).' },
        toFrame: { type: 'number', description: 'Exclusive upper frame bound.' },
        itemId: { type: 'string', description: 'Item id(s) or prefixes, comma-separated.' },
        assetId: { type: 'string', description: 'Asset id(s) or prefixes, comma-separated.' },
        code: { type: 'boolean', description: 'Include MG code when assetId is set.' },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
    },
  },
];

export const READ_PROJECT_TOOL_NAMES = new Set(READ_PROJECT_TOOL_SCHEMAS.map((t) => t.name));
