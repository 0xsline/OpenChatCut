// Bundled OpenChatCut agent skills include adapted ChatCut workflows and
// product-native creative workflows. Attribution and license details: ./NOTICE.md.
// Each skill includes SKILL.md plus optional supporting reference/example files.
// Architecture:
// progressive disclosure. A deterministic, bounded index sits in the system
// prompt when tools are available; full SKILL.md bodies load through load_skill.
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
const compareSlug = (a: { readonly slug: string }, b: { readonly slug: string }): number => (
  a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
);

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
  .sort(compareSlug);

export function getPluginSkill(slug: string): SkillFile | undefined {
  return PLUGIN_SKILLS.find((skill) => skill.slug === slug);
}

/** Parsed SKILL.md body, or the verbatim content of a named support file. */
export function readPluginSkillFile(slug: string, file?: string): string | undefined {
  if (!file) return getPluginSkill(slug)?.body;
  // The glob key is relative to this module directory (this file is in skills/):./<slug>/<file>, without skills/ prefix
  return RAW[`./${slug}/${file.replace(/^\.\//, '')}`];
}

const DEFAULT_SKILL_INDEX_BUDGET_CHARS = 12_000;
function skillIndexIntro(totalSkills: number): string {
  return [
    '',
    `# Skill library (load_skill on demand · ${totalSkills} OpenChatCut SKILL.md files)`,
    'Each entry below describes when a skill applies. Call load_skill(name=…) before acting. SKILL.md is returned first. Load omittedFiles whole with files=[…]; if a file remains omitted, page it with file=…, offset=nextOffset until nextOffset is null. Load only relevant skills.',
    'When a skill needs scripts, ffmpeg, node, or python, use run_code in the isolated sandbox: write files, run a command, then read outputs. The sandbox cannot access the timeline; use local editor tools to place resulting assets. For real media, pass a local /media/… or public https:// URL in files so the sandbox can fetch it for ffprobe/ffmpeg. Public URLs may also be passed directly to ffprobe.',
    'The custom sandbox image includes ffmpeg. If an environment lacks it, install it first with: `which ffmpeg || (sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg)`.',
  ].join('\n');
}
const SKILLS_UNAVAILABLE_PROMPT = [
  '',
  '# Skill library unavailable',
  'This model cannot call tools, so load_skill workflows are not available in this request.',
].join('\n');

export interface PluginSkillIndexEntry {
  readonly slug: string;
  readonly description: string;
}

export interface PluginSkillsIndexDiagnostics {
  readonly toolsAvailable: boolean;
  readonly budgetChars: number;
  readonly promptChars: number;
  readonly totalSkills: number;
  readonly advertisedSkills: number;
  readonly omittedSkills: number;
  /** Description-line characters, excluding shared prompt framing. */
  readonly totalChars: number;
  readonly advertisedChars: number;
  readonly omittedChars: number;
}

export interface PluginSkillsIndexBuild {
  readonly prompt: string;
  readonly diagnostics: PluginSkillsIndexDiagnostics;
}

export interface PluginSkillsIndexOptions {
  readonly toolsAvailable?: boolean;
  readonly budgetChars?: number;
}

const detailLine = (skill: PluginSkillIndexEntry): string => (
  `- **${skill.slug}** — ${skill.description}`
);

function overflowIndex(skills: readonly PluginSkillIndexEntry[], budgetChars: number): string {
  if (skills.length === 0) return '';
  return [
    '',
    `Descriptions omitted to fit the ${budgetChars}-character budget. All remain loadable by exact name:`,
    ...skills.map((skill) => `- ${skill.slug}`),
  ].join('\n');
}

function skillsDiagnostics(
  all: readonly PluginSkillIndexEntry[],
  advertised: readonly PluginSkillIndexEntry[],
  prompt: string,
  toolsAvailable: boolean,
  budgetChars: number,
): PluginSkillsIndexDiagnostics {
  const totalChars = all.reduce((sum, skill) => sum + detailLine(skill).length, 0);
  const advertisedChars = advertised.reduce((sum, skill) => sum + detailLine(skill).length, 0);
  return {
    toolsAvailable,
    budgetChars,
    promptChars: prompt.length,
    totalSkills: all.length,
    advertisedSkills: advertised.length,
    omittedSkills: all.length - advertised.length,
    totalChars,
    advertisedChars,
    omittedChars: totalChars - advertisedChars,
  };
}

/** Pure deterministic builder used by the bundled catalog and focused verification. */
export function buildSkillsIndex(
  entries: readonly PluginSkillIndexEntry[],
  options: PluginSkillsIndexOptions = {},
): PluginSkillsIndexBuild {
  const toolsAvailable = options.toolsAvailable ?? true;
  const budgetChars = options.budgetChars ?? DEFAULT_SKILL_INDEX_BUDGET_CHARS;
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 1) {
    throw new RangeError('Skill index budget must be a positive safe integer.');
  }
  const sorted = [...entries].sort(compareSlug);
  if (!toolsAvailable) {
    if (SKILLS_UNAVAILABLE_PROMPT.length > budgetChars) {
      throw new RangeError('Skill index budget cannot fit the tools-unavailable notice.');
    }
    return {
      prompt: SKILLS_UNAVAILABLE_PROMPT,
      diagnostics: skillsDiagnostics(sorted, [], SKILLS_UNAVAILABLE_PROMPT, false, budgetChars),
    };
  }
  for (let count = sorted.length; count >= 0; count -= 1) {
    const advertised = sorted.slice(0, count);
    const omitted = sorted.slice(count);
    const prompt = [
      skillIndexIntro(sorted.length),
      ...advertised.map(detailLine),
      overflowIndex(omitted, budgetChars),
    ].filter(Boolean).join('\n');
    if (prompt.length <= budgetChars) {
      return { prompt, diagnostics: skillsDiagnostics(sorted, advertised, prompt, true, budgetChars) };
    }
  }
  throw new RangeError('Skill index budget cannot fit the required exact-slug overflow index.');
}

const DEFAULT_AVAILABLE_INDEX = buildSkillsIndex(PLUGIN_SKILLS);
const DEFAULT_UNAVAILABLE_INDEX = buildSkillsIndex(PLUGIN_SKILLS, { toolsAvailable: false });

export function buildPluginSkillsIndex(
  options: PluginSkillsIndexOptions = {},
): PluginSkillsIndexBuild {
  if (options.budgetChars === undefined) {
    return options.toolsAvailable === false ? DEFAULT_UNAVAILABLE_INDEX : DEFAULT_AVAILABLE_INDEX;
  }
  return buildSkillsIndex(PLUGIN_SKILLS, options);
}

/** Backward-compatible default; new prompt assembly should call the builder. */
export const PLUGIN_SKILLS_INDEX = DEFAULT_AVAILABLE_INDEX.prompt;
export const PLUGIN_SKILLS_INDEX_DIAGNOSTICS = DEFAULT_AVAILABLE_INDEX.diagnostics;
