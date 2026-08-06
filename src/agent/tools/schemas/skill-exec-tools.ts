import type { AgentToolSchema } from '../../tool-schema';

export const RUN_SKILL_SCRIPT_TOOL_NAMES = new Set(['run_skill_script']);

export const RUN_SKILL_SCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'run_skill_script',
    description: '在本机执行已安装技能目录内的脚本（白名单命令：bash/sh/node/npm/npx/python3/python/uv/uvx/ffmpeg/ffprobe/mkdir/cp/chmod），工作目录锁定在技能目录。用于运行技能自带的确定性脚本（如 render.mjs、check-deps.sh），云沙箱无法访问本机技能文件。超时默认 60s、上限 120s；输出最多 512KB。',
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能 slug（load_skill 返回的 skill 字段）' },
        command: { type: 'string', description: '命令（首个词必须是白名单内可执行文件），如 bash scripts/check-deps.sh 或 node scripts/render.mjs' },
        timeout: { type: 'number', description: '可选：超时毫秒，默认 60000，上限 120000' },
      },
      required: ['skill', 'command'],
    },
  },
];
