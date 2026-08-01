// Bundled OpenChatCut agent skills include adapted ChatCut workflows and
// product-native creative workflows. Attribution and license details: ./NOTICE.md.
// Each skill includes SKILL.md plus optional supporting reference/example files.
// Architecture:
// progressive disclosure. Each skill's name+description sits in the system prompt
// (PLUGIN_SKILLS_INDEX, always in context); the parsed SKILL.md body loads on
// demand via load_skill — the Agent Skills progressive-disclosure contract.
import { parseSkillFrontmatter, type SkillFront } from './skill-frontmatter';

// Vite raw-imports every file under skills/ (SKILL.md + references/examples/scripts).
const RAW = (typeof import.meta.env === 'undefined'
  ? {}
  : import.meta.glob('./*/**/*', {
      query: '?raw',
      import: 'default',
      eager: true,
    })) as Record<string, string>;

export interface SkillFile extends SkillFront {
  slug: string;
  files: string[];
}

const slugOf = (path: string): string => path.replace(/^\.\//, '').split('/')[0];

export const PLUGIN_SKILLS: SkillFile[] = Object.entries(RAW)
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

export function getPluginSkill(slug: string): SkillFile | undefined {
  return PLUGIN_SKILLS.find((skill) => skill.slug === slug);
}

/** Parsed SKILL.md body, or the verbatim content of a named support file. */
export function readPluginSkillFile(slug: string, file?: string): string | undefined {
  if (!file) return getPluginSkill(slug)?.body;
  // The glob key is relative to this module directory (this file is in skills/):./<slug>/<file>, without skills/ prefix
  return RAW[`./${slug}/${file.replace(/^\.\//, '')}`];
}

// The always-in-context index (progressive disclosure). Appended to the system prompt.
export const PLUGIN_SKILLS_INDEX: string = [
  '',
  `# Skill library (load_skill on demand · ${PLUGIN_SKILLS.length} OpenChatCut SKILL.md files)`,
  'Each entry below describes when a skill applies. When a task matches one, call load_skill(name=…) to retrieve its full workflow before acting. For deeper material, pass file= (for example, "references/voices.md"). Load only relevant skills, not the entire library.',
  'When a skill needs scripts, ffmpeg, node, or python, use run_code in the isolated sandbox: write files, run a command, then read outputs. The sandbox cannot access the timeline; use local editor tools to place resulting assets. For real media, pass a local /media/… or public https:// URL in files so the sandbox can fetch it for ffprobe/ffmpeg. Public URLs may also be passed directly to ffprobe.',
  'The custom sandbox image includes ffmpeg. If an environment lacks it, install it first with: `which ffmpeg || (sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg)`.',
  ...PLUGIN_SKILLS.map((s) => `- **${s.slug}** — ${s.description}`),
].join('\n');
