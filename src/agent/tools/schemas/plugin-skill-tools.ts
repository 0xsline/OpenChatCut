import type { AgentToolSchema } from '../../tool-schema';
import { PLUGIN_SKILLS } from '../../skills/plugin-skills';

export const PLUGIN_SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'load_skill',
    description:
      'Load the full verbatim guidance of one plugin skill (its SKILL.md) from the skill library listed in the system prompt. Call this when the task matches a skill\'s description, before doing the work. Pass file= to load a support doc under the skill instead of SKILL.md. Available skills: '
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
