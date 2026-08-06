export { PLUGIN_SKILL_TOOL_SCHEMAS, PLUGIN_SKILL_TOOL_NAMES } from './schemas/plugin-skill-tools';
// load_skill resolves bundled and custom skills. Per product decision, a skill
// is loaded FULLY: the system prompt keeps only names and descriptions, and the
// first load_skill call returns the SKILL.md body plus the contents of every
// support file (references/scripts/examples) — no progressive per-file fetch,
// no truncation. The dependency check (skill-deps) runs against those full
// contents so foreign services in references are detected too.
import { PLUGIN_SKILLS, readPluginSkillFile } from '../skills/plugin-skills';
import { allCreativeSkills } from '../skills/skills-catalog';
import { detectSkillDependencies } from '../skills/skill-deps';

const fullContent = (files: string[], read: (file: string) => string | undefined): Record<string, string> => {
  const contents: Record<string, string> = {};
  for (const file of files) {
    const content = read(file);
    if (content !== undefined) contents[file] = content;
  }
  return contents;
};

export function execPluginSkillTool(name: string, args: Record<string, unknown>): unknown {
  if (name !== 'load_skill') return { error: `unknown tool ${name}` };
  const slug = String(args.name ?? '').trim();
  const skill = PLUGIN_SKILLS.find((s) => s.slug === slug);
  if (!skill) {
    const creative = allCreativeSkills().find((candidate) => candidate.slug === slug || candidate.id === slug);
    if (creative) {
      const contents = creative.fileContents ?? { 'SKILL.md': creative.body };
      if (contents['SKILL.md'] === undefined) contents['SKILL.md'] = creative.body;
      const deps = detectSkillDependencies(Object.values(contents).join('\n'));
      return {
        skill: creative.slug,
        file: 'SKILL.md',
        files: Object.keys(contents).sort(),
        contents,
        skillDir: `~/.openchatcut/skills/${creative.slug}`,
        dependencyCheck: deps.map((d) => d.service),
        note: 'Custom creative-mode skill loaded in full (SKILL.md + all support files). Run its scripts locally with run_skill_script(skill=…, command="bash scripts/…") — never copy them into the cloud sandbox.',
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
  // Built-in skill: full directory contents, SKILL.md first (body already has
  // its frontmatter stripped; support files stay verbatim).
  const contents = fullContent(skill.files, (file) => readPluginSkillFile(slug, file));
  contents['SKILL.md'] = skill.body;
  const deps = detectSkillDependencies(Object.values(contents).join('\n'));
  return {
    skill: slug,
    file: 'SKILL.md',
    files: Object.keys(contents).sort(),
    contents,
    dependencyCheck: deps.map((d) => d.service),
    note: 'Skill loaded in full (SKILL.md + all support files).',
  };
}
