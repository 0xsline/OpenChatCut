import type { AgentToolSchema } from '../../tool-schema';

export const AUTO_GRADE_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'auto_grade',
  description:
    'Technical auto color correction for imported pool media on the timeline (video/image/gif under /media/uploads). '
    + 'action=analyze measures brightness/contrast/saturation and returns recommended filters without writing. '
    + 'action=apply analyzes then writes setFilters on each target as one undo batch. '
    + 'Neutral cleanup only — not creative LUTs/looks (use browse_library + edit_item for those). '
    + 'Prefer inspect_color after apply to verify numbers. itemIds optional; omit to grade every eligible clip on the active timeline.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['analyze', 'apply'],
        description: 'analyze = preview recommendations only; apply = analyze + commit filters.',
      },
      itemIds: {
        type: 'string',
        description: 'Comma-separated clip ids/prefixes. Omit to target all eligible video/image/gif clips with /media/uploads sources.',
      },
    },
    required: ['action'],
  },
}];

export const AUTO_GRADE_TOOL_NAMES = new Set(AUTO_GRADE_TOOL_SCHEMAS.map((tool) => tool.name));
