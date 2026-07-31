import type { AgentToolSchema } from '../../tool-schema';

export const MULTICAM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'multicam_sync',
    description: [
      'Persistent multicam alignment. Prefers normalized source timecode, then capture clock, and falls back to',
      'audio correlation per angle. Creates or updates a durable group with its reference/master, source snapshots,',
      'offsets, confidence and sync evidence; all placements and metadata commit as one undoable state change.',
      'Every selected angle must use the same playback rate; unify rates before retrying a rejected sync.',
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
        groupId: {
          type: 'string',
          description: 'Existing multicam group id to update. Omit to create or discover one from the selected items.',
        },
        masterItemId: {
          type: 'string',
          description: 'Optional program/master angle item id. Defaults to referenceItemId.',
        },
      },
      required: ['itemIds'],
    },
  },
  {
    name: 'change_cam',
    description: [
      'Persistent multicam range switch. Pass groupId + targetAngleId and [fromSeconds,toSeconds); the editor',
      'uses the rippleless split/remove planner, restores source coverage when a prior decision removed that angle,',
      'and saves a replaceable right-open angle decision. The complete result commits once; failures commit nothing.',
      'Legacy itemIds + targetItemId remain accepted for a group created by multicam_sync.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        groupId: {
          type: 'string',
          description: 'Persistent multicam group id. Preferred over itemIds.',
        },
        targetAngleId: {
          type: 'string',
          description: 'Persistent angle id (or its original item id) to show.',
        },
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Legacy group lookup: current/original ids of angles previously passed to multicam_sync.',
        },
        targetItemId: { type: 'string', description: 'Legacy alias for targetAngleId.' },
        fromSeconds: { type: 'number', description: 'Switch start, timeline seconds.' },
        toSeconds: { type: 'number', description: 'Switch end (exclusive), timeline seconds. Default: end of target source.' },
      },
      required: ['fromSeconds'],
    },
  },
  {
    name: 'manage_link_group',
    description: [
      'Create or remove persistent timeline edit relationships as one undoable change.',
      'action=link couples A/V move, trim and remove; action=sync_lock preserves group timing through direct moves',
      'and ripple edits; action=unlink removes the selected memberships. Pass 2+ itemIds for link/sync_lock.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['link', 'sync_lock', 'unlink'] },
        itemIds: { type: 'array', items: { type: 'string' } },
        anchorItemId: { type: 'string', description: 'Optional anchor; defaults to the first resolved item.' },
      },
      required: ['action', 'itemIds'],
    },
  },
];

export const MULTICAM_TOOL_NAMES = new Set(MULTICAM_TOOL_SCHEMAS.map((t) => t.name));
