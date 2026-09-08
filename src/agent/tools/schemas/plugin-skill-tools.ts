import type { AgentToolSchema } from '../../tool-schema';
import { PLUGIN_SKILLS } from '../../skills/plugin-skills';

export const PLUGIN_SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'load_skill',
    description:
      'Load one bundled or selected custom skill under the active model round input budget. Omit selectors for SKILL.md; if it is paged, follow nextOffset until null before support files. Exactly one selector per call: either files=[...] to load whole omitted files, or file with offset and limit to page a single file. Never send file and files in the same call. Bundled skills: '
      + PLUGIN_SKILLS.map((skill: { slug: string }) => skill.slug).join(', ') + '.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill id, e.g. "talking-head-guide", "voice", "shader-gen".' },
        file: { type: 'string', description: 'One safe relative file path to page; use returned nextOffset for the next call. Omit the key entirely when sending files; never pass an empty string.' },
        files: {
          type: 'array',
          description: 'Optional safe relative paths from omittedFiles. When present, only these whole files are returned. Omit the key entirely when paging with file; never pass an empty array.',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 64,
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'UTF-16 character offset for file paging; must not split a surrogate pair.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 48_000,
          description: 'Maximum UTF-16 characters requested; the runtime may return a smaller exact page to fit the active input budget.',
        },
      },
      required: ['name'],
    },
  },
];

export const PLUGIN_SKILL_TOOL_NAMES = new Set(PLUGIN_SKILL_TOOL_SCHEMAS.map((t) => t.name));
