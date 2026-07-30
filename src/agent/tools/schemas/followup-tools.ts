import type { AgentToolSchema } from '../../tool-schema';

export const FOLLOWUP_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'ask_followup_questions',
  description:
    'Ask the user up to 12 follow-up questions in an interactive card, then WAIT for the next user message. Each field accepts type "single", "multi", or "text" and variant "default", "visual", "voice", or "scenario". Options accept id/label (or value/display), description, preview/media, audioUrl, aspectRatio, and submitPrompt. Use text fields for free-form answers, visual for image choices, voice for playable voice choices, and scenario for workflow choices.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'Fields: { id, label, type, variant?, description?, placeholder?, otherPlaceholder?, options?, required?, allowOther? }.',
        items: { type: 'object' },
      },
      prompt: { type: 'string', description: 'Optional text shown above the card.' },
      title: { type: 'string', description: 'Optional card title.' },
      submitLabel: { type: 'string', description: 'Optional submit button label.' },
      messagePrefix: { type: 'string', description: 'Optional prefix prepended to the submitted answer.' },
    },
    required: ['fields'],
  },
}];

export const FOLLOWUP_TOOL_NAMES = new Set(FOLLOWUP_TOOL_SCHEMAS.map((t) => t.name));
