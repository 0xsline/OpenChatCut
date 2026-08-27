import type { AgentToolSchema } from '../../tool-schema';

export const READ_PROJECT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_project',
    description: [
      'Read the project currently targeted by this agent session, including draft state visible to the current tool context.',
      'Default = full overview. Narrow with view:"timeline"|"assets", timelineId, track, fromFrame/toFrame, itemId, or assetId; projectId cannot retarget this call.',
      'Unknown timeline/track references return an error. itemId/assetId are filters, so unmatched prefixes return empty item/asset arrays rather than an error.',
      'Pass code:true with assetId to include MG source code. Read at session start or after out-of-band changes; between your own edits, apply mutation deltas unless a note requests a reread.',
      'Timeline items include canonical media linkage (sourceAssetId, resolvedSourceAssetId, linkStatus), exact source window (srcInFrame, sourceStartFrame, sourceDurationInFrames, sourceEndFrameExclusive), and editable state (keyframes, transform, filters, volume, fadeInFrames, fadeOutFrames).',
      'timeline.selectedId / selectedIds / selected is the inspector selection. If the user says "the selected clip" or "this clip", use that id — do not pick an adjacent track. Video aliases are bottom-up: V1 is the bottom video track, not the top lane.',
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
        projectId: { type: 'string', description: 'Ignored. Use target_project first; this reads the project targeted by the current session.' },
      },
      additionalProperties: false,
    },
  },
];

export const READ_PROJECT_TOOL_NAMES = new Set(READ_PROJECT_TOOL_SCHEMAS.map((t) => t.name));
