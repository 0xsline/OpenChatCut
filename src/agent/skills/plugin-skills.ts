// The 15 bundled OpenChatCut agent skills are adapted from
// ChatCut-Inc/agent-plugin. Attribution and license details: ./NOTICE.md.
// Each skill includes SKILL.md plus optional supporting reference/example files.
// Architecture:
// progressive disclosure. Each skill's name+description sits in the system prompt
// (PLUGIN_SKILLS_INDEX, always in context); the full verbatim SKILL.md body loads on
// demand via the load_skill tool — exactly the Agent Skills contract ("description in
// context, body on demand"), minus the code-execution container the native API feature
// needs (which our relay + local-tool architecture can't provide). Nothing is
// internalized: load_skill returns the bundled file bytes unchanged.
import { parseSkillFrontmatter, type SkillFront } from './skill-frontmatter';

// Vite raw-imports every file under skills/ (SKILL.md + references/examples/scripts).
const RAW = import.meta.glob('./*/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface PluginSkill extends SkillFront {
  slug: string; // Directory name is the stable skill id.
  files: string[]; // relative support files (references/*, examples/*, scripts/*)
}

const slugOf = (path: string): string => path.replace(/^\.\//, '').split('/')[0];

export const PLUGIN_SKILLS: PluginSkill[] = Object.entries(RAW)
  .filter(([p]) => p.endsWith('/SKILL.md'))
  .map(([path, raw]) => {
    const slug = slugOf(path);
    const files = Object.keys(RAW)
      .filter((p) => slugOf(p) === slug && !p.endsWith('/SKILL.md'))
      .map((p) => p.replace(`./${slug}/`, ''))
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
  // The glob key is relative to this module directory (this file is in skills/): ./<slug>/<file>, without skills/ prefix
  return RAW[`./${slug}/${file.replace(/^\.\//, '')}`];
}

// The always-in-context index (progressive disclosure). Appended to the system prompt.
export const PLUGIN_SKILLS_INDEX: string = [
  '',
  '# Skill Library (load_skill Load on demand · OpenChatCut of 15 a SKILL.md）',
  'Each of the following is an application scenario for a skill. When a task hits a certain skill, first load_skill(name=…) Complete guided process to get it back (SKILL.md Full text) before starting; you can bring it when you need more information file=(such as "references/voices.md"). Only load when relevant, don’t load everything.',
  'Any skill needs to run a script / ffmpeg / node / python, use both run_code Tools are executed in an isolation sandbox (files write → command run → outputs Read back the product; the sandbox cannot touch the timeline, and the product needs to be dropped into the editor using local tools). Real media:files Item to give url(local /media/… or public network https://) can be pulled into the sandbox ffprobe/ffmpeg (the public URL can also be fed directly to ffprobe). ',
  'The sandbox is installed by default ffmpeg(Customized template); if a certain environment does not exist, install it first in the command:`which ffmpeg || (sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg)`。',
  ...PLUGIN_SKILLS.map((s) => `- **${s.slug}** — ${s.description}`),
].join('\n');
