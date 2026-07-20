// load_skill — progressive-disclosure loader for the 15 bundled agent skills.
// The system prompt carries each skill's name+description (PLUGIN_SKILLS_INDEX); when a
// task matches, the agent calls load_skill to pull that skill's full SKILL.md body (or a
// support file under it) unchanged. This is our portable stand-in for the native Agent
// Skills container feature, which our relay + local-tool architecture can't run.
import type { AgentToolSchema } from '../tool-schema';
import { PLUGIN_SKILLS, readPluginSkillFile } from '../skills/plugin-skills';
import { allCreativeSkills } from '../skills/skills-catalog';

// 创作模式技能也可按其 frontmatter name(如 "long-video-to-shorts")load —
// 模式正文常驻注入是主路径,但 agent 在对话中途想复读工作流时会按 body 里的
// name 调 load_skill(长转短 e2e 实测两次吃了 no such skill),这里兜住。
function creativeSlug(body: string): string | undefined {
  return /^---[\s\S]*?\bname:\s*([\w-]+)/.exec(body)?.[1];
}

export const PLUGIN_SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [
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
