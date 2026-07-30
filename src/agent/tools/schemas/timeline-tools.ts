import type { AgentToolSchema } from '../../tool-schema';

export const TIMELINE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'manage_timelines',
    description:
      'Manage the project\'s timelines (sequences): list, create, duplicate, switch, update (rename / resize canvas / hide), delete. Each timeline has its own canvas (width×height / ratio) — duplicate + update ratio="9:16" is the long-to-short workflow. switch makes a timeline active: later tool calls this turn and the user\'s editor view follow it.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'duplicate', 'switch', 'update', 'delete'], description: 'What to do.' },
        timelineId: { type: 'string', description: 'Target timeline id (prefix ok). Required for duplicate/switch; update defaults to the active timeline.' },
        timelineIds: { type: 'array', items: { type: 'string' }, description: 'delete: several timeline ids (prefixes ok).' },
        name: { type: 'string', description: 'create/duplicate: the new timeline\'s name; update: rename.' },
        ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], description: 'Canvas aspect preset (create/update). Use ratio OR explicit width+height, not both.' },
        width: { type: 'integer', description: 'Explicit canvas width px (create/update, omit when ratio is given).' },
        height: { type: 'integer', description: 'Explicit canvas height px (create/update, omit when ratio is given).' },
        fit: { type: 'string', enum: ['contain', 'cover'], description: 'update: how existing clips adapt to the new canvas — contain letterboxes, cover fills+crops.' },
        hidden: { type: 'boolean', description: 'update: hide (true) or restore (false) the timeline tab; data is kept. The last visible timeline cannot be hidden.' },
        activate: { type: 'boolean', description: 'create/duplicate: false keeps the current timeline active (default true; batch create activates the last entry).' },
        timelines: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ratio: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' } } }, description: 'create: several timelines at once, each {name, ratio | width+height}.' },
      },
      required: ['action'],
    },
  },
];

export const TIMELINE_TOOL_NAMES = new Set(TIMELINE_TOOL_SCHEMAS.map((t) => t.name));
