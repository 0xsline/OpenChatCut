import type { AgentToolSchema } from '../../tool-schema';

export const SCENE_QUALITY_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'review_scene_plan',
    description: [
      'Advisory review of a multi-scene plan for repetition, decorative visuals, static-card overuse, and generic language.',
      'Returns a normalized 0–5 risk score, revision advice, and affected scene numbers.',
      'The report is optional advice and never blocks or authorizes submit_image/submit_video.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          minItems: 1,
          description: 'Ordered scenes to review. type comparison trims whitespace and ignores case; blank responsibility fields count as missing.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Scene form, e.g. video, image, text_card, chart.' },
              description: { type: 'string', description: 'Concrete visual description.' },
              shotIntent: { type: 'string', description: 'Why this shot exists.' },
              informationRole: { type: 'string', description: 'What this scene communicates.' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
      },
      required: ['scenes'],
      additionalProperties: false,
    },
  },
];

export const SCENE_QUALITY_TOOL_NAMES = new Set(SCENE_QUALITY_TOOL_SCHEMAS.map((tool) => tool.name));
