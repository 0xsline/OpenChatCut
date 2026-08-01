import type { AgentToolSchema } from '../../tool-schema';

export const SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_skill',
  description: [
    'A custom creative skill is reusable workflow guidance in bodyMarkdown. It appears beside built-in skills in the Creative Mode picker and is loaded through load_skill after selection.',
    'action: list | get | current | activate | create | update | delete.',
    'list returns all read-only built-in and custom skills with id/slug/name/summary plus activeSkillId.',
    'get with skillId returns details including the full body and a builtin flag.',
    'current returns the active creative mode or active:null.',
    'activate with skillId switches the project creative mode; pass an empty string to clear it. The next message is instructed to load the selected skill before acting.',
    'create with name + body and optional summary/scenarios creates a custom skill and id; a SKILL.md frontmatter name becomes its load_skill slug.',
    'update with skillId and changed fields edits a custom skill; built-ins are read-only.',
    'delete with skillId removes a custom skill; built-ins cannot be deleted.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'current', 'activate', 'create', 'update', 'delete'] },
      skillId: { type: 'string', description: 'Target skill id for get/update/delete/activate; call list first. Pass an empty string to activate to clear Creative Mode.' },
      name: { type: 'string', description: 'create/update: display name; required and non-empty for create.' },
      body: { type: 'string', description: 'create/update: Markdown workflow returned by load_skill; required and non-empty for create.' },
      summary: { type: 'string', description: 'create/update: optional one-line description; create defaults to name.' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'create/update: optional trigger-scenario keywords.' },
    },
    required: ['action'],
  },
}];

export const SKILL_TOOL_NAMES = new Set(SKILL_TOOL_SCHEMAS.map((t) => t.name));
