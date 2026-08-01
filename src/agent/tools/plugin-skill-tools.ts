export { PLUGIN_SKILL_TOOL_SCHEMAS, PLUGIN_SKILL_TOOL_NAMES } from './schemas/plugin-skill-tools';
// load_skill resolves bundled and custom skills through one progressive-disclosure
// path. The system prompt keeps only names and descriptions.
import { PLUGIN_SKILLS, readPluginSkillFile } from '../skills/plugin-skills';
import { allCreativeSkills } from '../skills/skills-catalog';


export function execPluginSkillTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== 'load_skill') return { error: `unknown tool ${name}` };
  const slug = String(args.name ?? '').trim();
  const skill = PLUGIN_SKILLS.find((s) => s.slug === slug);
  if (!skill) {
    const creative = allCreativeSkills().find((candidate) => candidate.slug === slug || candidate.id === slug);
    if (creative) {
      return {
        skill: creative.slug,
        file: 'SKILL.md',
        files: creative.files,
        note: 'Custom creative-mode skill loaded on demand.',
        content: creative.body,
      };
    }
    return {
      error: `no such skill "${slug}"`,
      available: PLUGIN_SKILLS.map((s) => s.slug),
      creativeModes: allCreativeSkills()
        .filter((candidate) => candidate.source === 'custom')
        .map((candidate) => candidate.slug),
    };
  }
  const file = args.file ? String(args.file).trim() : undefined;
  const content = readPluginSkillFile(slug, file);
  if (content === undefined) return { error: `skill "${slug}" has no file "${file}"`, files: skill.files };
  return { skill: slug, file: file ?? 'SKILL.md', files: skill.files, content };
}
