// The 15 ChatCut agent-plugin skills, brought over VERBATIM (byte-for-byte from
// chatcut-reverse/harness/chatcut-plugin-skills/chatcut/skills — SKILL.md + every
// references/examples/scripts file). This reproduces the source's own architecture:
// progressive disclosure. Each skill's name+description sits in the system prompt
// (PLUGIN_SKILLS_INDEX, always in context); the full verbatim SKILL.md body loads on
// demand via the load_skill tool — exactly the Agent Skills contract ("description in
// context, body on demand"), minus the code-execution container the native API feature
// needs (which our relay + local-tool architecture can't provide). Nothing is
// paraphrased or internalized: load_skill returns the source bytes unchanged.
import { parseSkillFrontmatter, type SkillFront } from './skill-frontmatter';

// Vite raw-imports every file under skills/ (SKILL.md + references/examples/scripts).
const RAW = import.meta.glob('./skills/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface PluginSkill extends SkillFront {
  slug: string; // directory name = source skill id
  files: string[]; // relative support files (references/*, examples/*, scripts/*)
}

const slugOf = (path: string): string => path.replace(/^\.\/skills\//, '').split('/')[0];

export const PLUGIN_SKILLS: PluginSkill[] = Object.entries(RAW)
  .filter(([p]) => p.endsWith('/SKILL.md'))
  .map(([path, raw]) => {
    const slug = slugOf(path);
    const files = Object.keys(RAW)
      .filter((p) => slugOf(p) === slug && !p.endsWith('/SKILL.md'))
      .map((p) => p.replace(`./skills/${slug}/`, ''))
      .sort();
    return { slug, files, ...parseSkillFrontmatter(raw) };
  })
  .sort((a, b) => a.slug.localeCompare(b.slug));

export function getPluginSkill(slug: string): PluginSkill | undefined {
  return PLUGIN_SKILLS.find((s) => s.slug === slug);
}

/** Verbatim content of a skill's SKILL.md, or a named support file under it. */
export function readPluginSkillFile(slug: string, file?: string): string | undefined {
  if (!file) return getPluginSkill(slug)?.body;
  return RAW[`./skills/${slug}/${file}`];
}

// The always-in-context index (progressive disclosure). Appended to the system prompt.
export const PLUGIN_SKILLS_INDEX: string = [
  '',
  '# 技能库（load_skill 按需加载 · 源 agent-plugin 的 15 个 SKILL.md，逐字搬运）',
  '下面每条是一个技能的适用场景。当任务命中某技能时，先 load_skill(name=…) 取回它的完整指导流程（SKILL.md 全文）再动手；需要深料时可带 file=（如 "references/voices.md"）。只在相关时加载，别全部加载。',
  ...PLUGIN_SKILLS.map((s) => `- **${s.slug}** — ${s.description}`),
].join('\n');
