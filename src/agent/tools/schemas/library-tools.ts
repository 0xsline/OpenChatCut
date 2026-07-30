import type { AgentToolSchema } from '../../tool-schema';

const LIBRARY_CATEGORIES = [
  'motion-graphics', 'luts', 'zoom', 'fx', 'audio-fx', 'sound-effects', 'transitions',
] as const;

export const LIBRARY_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'browse_library',
    description:
      'Browse the OpenChatCut Library (not the user media pool). Categories match Library tabs: motion-graphics, luts, zoom, fx, audio-fx, sound-effects, transitions. Modes: (1) category only → group overview; (2) category+group or query → list of id/name/description; (3) id → full detail + edit_item usage. After discovery, place with edit_item (effect/transition/zoom/audio).',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [...LIBRARY_CATEGORIES],
          description: 'Optional Library tab filter.',
        },
        group: { type: 'string', description: 'Optional group within category (e.g. template category, sound group name).' },
        query: { type: 'string', description: 'Case-insensitive search over id/name/description/group. Returns a list.' },
        id: { type: 'string', description: 'Exact library asset id for detail + usage guidance.' },
        limit: { type: 'number', description: 'Max list results (default 30, max 50).' },
        offset: { type: 'number', description: 'List offset (default 0).' },
      },
    },
  },
];

export const LIBRARY_TOOL_NAMES = new Set(LIBRARY_TOOL_SCHEMAS.map((t) => t.name));
