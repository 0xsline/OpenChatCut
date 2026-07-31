export { PLUGIN_SKILL_TOOL_SCHEMAS, PLUGIN_SKILL_TOOL_NAMES } from './schemas/plugin-skill-tools';
// load_skill — progressive-disclosure loader for the 15 bundled agent skills.
// The system prompt carries each skill's name+description (PLUGIN_SKILLS_INDEX); when a
// task matches, the agent calls load_skill to pull that skill's full SKILL.md body (or a
// support file under it) unchanged. This is our portable stand-in for the native Agent
// Skills container feature, which our relay + local-tool architecture can't run.
import { PLUGIN_SKILLS, readPluginSkillFile } from '../skills/plugin-skills';
import { allCreativeSkills } from '../skills/skills-catalog';

// Creative mode skills can also be loaded by their frontmatter name (such as "long-video-to-shorts") —
// The mode body resident injection is the main path, but when the agent wants to repeat the workflow in the middle of the conversation, it will press in the body
// name adjusts load_skill (change from long to short e2e measured twice, no such skill), stop here.
function creativeSlug(body: string): string | undefined {
  return /^---[\s\S]*?\bname:\s*([\w-]+)/.exec(body)?.[1];
}

export function execPluginSkillTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== 'load_skill') return { error: `unknown tool ${name}` };
  const slug = String(args.name ?? '').trim();
  const skill = PLUGIN_SKILLS.find((s) => s.slug === slug);
  if (!skill) {
    const creative = allCreativeSkills().find((s) => creativeSlug(s.body) === slug || s.id === slug);
    if (creative) {
      return {
        skill: slug, file: 'SKILL.md', files: [],
        note: '创作模式技能(选中该创作模式时同一内容会常驻注入系统提示)。',
        content: creative.body,
      };
    }
    return {
      error: `no such skill "${slug}"`,
      available: PLUGIN_SKILLS.map((s) => s.slug),
      creativeModes: allCreativeSkills().map((s) => creativeSlug(s.body) ?? s.id),
    };
  }
  const file = args.file ? String(args.file).trim() : undefined;
  const content = readPluginSkillFile(slug, file);
  if (content === undefined) return { error: `skill "${slug}" has no file "${file}"`, files: skill.files };
  return { skill: slug, file: file ?? 'SKILL.md', files: skill.files, content };
}
