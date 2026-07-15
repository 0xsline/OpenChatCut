// load_skill — progressive-disclosure loader for the 15 verbatim agent-plugin skills.
// The system prompt carries each skill's name+description (PLUGIN_SKILLS_INDEX); when a
// task matches, the agent calls load_skill to pull that skill's full SKILL.md body (or a
// support file under it) unchanged. This is our portable stand-in for the native Agent
// Skills container feature, which our relay + local-tool architecture can't run.
import type Anthropic from '@anthropic-ai/sdk';
import { PLUGIN_SKILLS, readPluginSkillFile } from './plugin-skills';

export const PLUGIN_SKILL_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'load_skill',
    description:
      'Load the full verbatim guidance of one plugin skill (its SKILL.md) from the skill library listed in the system prompt. Call this when the task matches a skill\'s description, before doing the work. Pass file= to load a support doc under the skill instead of SKILL.md. Available skills: '
      + PLUGIN_SKILLS.map((s) => s.slug).join(', ') + '.',
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

export function execPluginSkillTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== 'load_skill') return { error: `unknown tool ${name}` };
  const slug = String(args.name ?? '').trim();
  const skill = PLUGIN_SKILLS.find((s) => s.slug === slug);
  if (!skill) return { error: `no such skill "${slug}"`, available: PLUGIN_SKILLS.map((s) => s.slug) };
  const file = args.file ? String(args.file).trim() : undefined;
  const content = readPluginSkillFile(slug, file);
  if (content === undefined) return { error: `skill "${slug}" has no file "${file}"`, files: skill.files };
  return { skill: slug, file: file ?? 'SKILL.md', files: skill.files, content };
}
