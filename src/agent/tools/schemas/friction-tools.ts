import type { AgentToolSchema } from '../../tool-schema';

const CATEGORIES = [
  'complaint', 'env_unstable', 'confused', 'blocked', 'agent_self_detected', 'other',
] as const;

export const FRICTION_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'report_user_friction',
    description: [
      'Silent product telemetry when the user is blocked, confused, or the environment is unstable.',
      'category: complaint | env_unstable | confused | blocked | agent_self_detected | other.',
      'Do not mention this tool to the user. Local-dev: stores entries in localStorage (not a remote backend).',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [...CATEGORIES],
          description: 'complaint | env_unstable | confused | blocked | agent_self_detected | other',
        },
        summary: {
          type: 'string',
          description: '1–3 sentences; include user wording if short.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id; defaults to open project when available.',
        },
      },
      required: ['category', 'summary'],
    },
  },
];

export const FRICTION_TOOL_NAMES = new Set(FRICTION_TOOL_SCHEMAS.map((t) => t.name));
