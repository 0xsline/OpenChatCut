import type { AgentToolSchema } from '../../tool-schema';

export const SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_skill',
  description: [
    'A custom creative skill is reusable workflow guidance in bodyMarkdown. It appears beside built-in skills in the Creative Mode picker and, when selected, is injected into the system prompt to guide planning and execution without changing available tools.',
    'action: list | get | current | activate | create | update | delete.',
    'list returns all read-only built-in and custom skills with id/name/summary plus activeSkillId.',
    'get with skillId returns details including the full body and a builtin flag.',
    'current returns the active creative mode or active:null.',
    'activate with skillId switches the project creative mode; pass an empty string to clear it. Use this after the user selects a mode in a form card. Its body is injected starting with the next message.',
    'create with name + body and optional summary/scenarios creates a custom skill and id; name/body must be non-empty.',
    'update with skillId and changed fields edits a custom skill; built-ins are read-only.',
    'delete with skillId removes a custom skill; built-ins cannot be deleted.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'current', 'activate', 'create', 'update', 'delete'] },
      skillId: { type: 'string', description: 'Target skill id for get/update/delete/activate; call list first. Pass an empty string to activate to clear Creative Mode.' },
      name: { type: 'string', description: 'create/update: display name; required and non-empty for create.' },
      body: { type: 'string', description: 'create/update: Markdown instructions injected into the system prompt; required and non-empty for create.' },
      summary: { type: 'string', description: 'create/update: optional one-line description; create defaults to name.' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'create/update: optional trigger-scenario keywords.' },
    },
    required: ['action'],
  },
}];

export const SKILL_TOOL_NAMES = new Set(SKILL_TOOL_SCHEMAS.map((t) => t.name));
