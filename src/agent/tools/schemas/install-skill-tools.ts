import type { AgentToolSchema } from '../../tool-schema';


export const INSTALL_SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'install_skill',
    description: '从 GitHub 安装一个 skill 仓库到本机技能目录（~/.openchatcut/skills/<slug>/），完整安装 SKILL.md 及其 references/scripts/assets/examples。安装后资源库「技能」面板会自动展示，可用 /skill:<slug> 或面板激活。repo 支持 GitHub URL 或 owner/repo（如 "Jane-xiaoer/paper-collage-ad-codex"）。slug 可选，默认取 SKILL.md 的 name 或仓库名。',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'GitHub 仓库：完整 URL（https://github.com/owner/repo）或 owner/repo' },
        slug: { type: 'string', description: '可选：安装目录名（必须 kebab-case），默认取 SKILL.md frontmatter name 或仓库名' },
      },
      required: ['repo'],
    },
  },
];

export const INSTALL_SKILL_TOOL_NAMES = new Set(INSTALL_SKILL_TOOL_SCHEMAS.map((t) => t.name));
