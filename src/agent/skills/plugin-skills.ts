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
  // glob 键相对本模块目录(本文件就在 skills/ 里):./<slug>/<file>,没有 skills/ 前缀
  return RAW[`./${slug}/${file.replace(/^\.\//, '')}`];
}

// The always-in-context index (progressive disclosure). Appended to the system prompt.
export const PLUGIN_SKILLS_INDEX: string = [
  '',
  '# 技能库（load_skill 按需加载 · OpenChatCut 的 15 个 SKILL.md）',
  '下面每条是一个技能的适用场景。当任务命中某技能时，先 load_skill(name=…) 取回它的完整指导流程（SKILL.md 全文）再动手；需要深料时可带 file=（如 "references/voices.md"）。只在相关时加载，别全部加载。',
  '任何技能要跑脚本 / ffmpeg / node / python，都用 run_code 工具在隔离沙箱执行（files 写入 → command 运行 → outputs 读回产物；沙箱碰不到时间线，产物要落编辑器仍走本地工具）。真实媒体：files 项给 url（本地 /media/… 或公网 https://）即可拉进沙箱 ffprobe/ffmpeg（公网 URL 也可直接喂 ffprobe）。',
  '沙箱默认已装 ffmpeg（自定义模板）；若某环境没有，命令里先自装：`which ffmpeg || (sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg)`。',
  ...PLUGIN_SKILLS.map((s) => `- **${s.slug}** — ${s.description}`),
].join('\n');
