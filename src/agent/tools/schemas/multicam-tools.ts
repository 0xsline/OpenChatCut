import type { AgentToolSchema } from '../../tool-schema';

export const MULTICAM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'multicam_sync',
    description: [
      'Audio-based multicam alignment. Pass 2+ video/audio itemIds from the same take;',
      'optionally set referenceItemId (defaults to first video). Repositions each follower so its picture matches',
      'the reference audio. Runs in the editor only — no cloud job. After a cut in the reference, split cutaways',
      'first then sync each piece. Returns synced/skipped ids and lag diagnostics.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Timeline item ids for all angles (reference + followers). At least 2.',
        },
        referenceItemId: {
          type: 'string',
          description: 'Optional reference angle id (must be in itemIds). Defaults to first video clip.',
        },
      },
      required: ['itemIds'],
    },
  },
  {
    name: 'change_cam',
    description: [
      'Multicam camera switch: within [fromSeconds,toSeconds) make targetItemId the visible angle by removing',
      'the overlapping segments of the OTHER listed angle clips (split at the range bounds, remove without ripple —',
      'nothing else on the timeline moves; ONE undoable batch). Angles must be video clips, aligned first via',
      'multicam_sync; clips sharing the target\'s source file count as the target angle. Audio tracks are untouched,',
      'so keep the program/reference audio on its own audio track. Call once per switch point to assemble a program.',
      'toSeconds defaults to the end of the listed group. Warns when the target does not cover the whole range.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Current clip ids of ALL angles in the multicam group (target + others). At least 2.',
        },
        targetItemId: { type: 'string', description: 'The angle to show in the range (must be in itemIds).' },
        fromSeconds: { type: 'number', description: 'Switch start, timeline seconds.' },
        toSeconds: { type: 'number', description: 'Switch end (exclusive), timeline seconds. Default: end of the group.' },
      },
      required: ['itemIds', 'targetItemId', 'fromSeconds'],
    },
  },
];

export const MULTICAM_TOOL_NAMES = new Set(MULTICAM_TOOL_SCHEMAS.map((t) => t.name));
