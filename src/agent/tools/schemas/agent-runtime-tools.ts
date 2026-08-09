import type { AgentToolSchema } from '../../tool-schema';

export const AGENT_RUNTIME_TOOL_NAMES = new Set(['read_agent_artifact']);

export const AGENT_RUNTIME_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'read_agent_artifact',
  description: 'Read a bounded slice of an archived Agent tool result in the current project. Use JSON Pointer to select a narrow field before paging with offset/limit.',
  input_schema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,20}$' },
      pointer: { type: 'string', maxLength: 1024, pattern: '^(?:|/(?:[^~]|~[01])*)$' },
      offset: { type: 'integer', minimum: 0, maximum: 8_388_608 },
      limit: { type: 'integer', minimum: 1, maximum: 12_000 },
    },
    required: ['artifactId'],
    additionalProperties: false,
  },
}];
