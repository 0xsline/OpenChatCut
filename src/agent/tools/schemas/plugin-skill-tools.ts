import type { AgentToolSchema } from '../../tool-schema';
import { PLUGIN_SKILLS } from '../../skills/plugin-skills';

export const PLUGIN_SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'load_skill',
    description:
      'Load the full guidance body of one bundled or selected custom skill. Call this when a task matches a skill description, before doing the work. Pass file= to load a bundled support doc instead of SKILL.md. Bundled skills: '
      + PLUGIN_SKILLS.map((skill: { slug: string }) => skill.slug).join(', ') + '.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill id, e.g. "talking-head-guide", "voice", "shader-gen".' },
        file: { type: 'string', description: 'Optional support file under the skill (e.g. "references/voices.md"); omit to load SKILL.md.' },
      },
      required: ['name'],
    },
  },
];

export const PLUGIN_SKILL_TOOL_NAMES = new Set(PLUGIN_SKILL_TOOL_SCHEMAS.map((t) => t.name));
