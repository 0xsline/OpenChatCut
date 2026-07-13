import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';

// ═══════════════════════════════════════════════════════════════════════════
// GPT 主攻文件 —— AI 生成套件（图 / 视频 / 配音 / 音乐 / 音效）
// ---------------------------------------------------------------------------
// 在这里注册所有「生成类」agent 工具。你只需要改这个文件 + 你新建的叶子文件
// （代理插件、库模块、面板），**不要改 tools.ts / store.ts / reduce.ts / types.ts
// / TimelineComposition.tsx / Editor.tsx（这些是 Claude 的共享脊柱）**。
//
// 接线已就绪：下面的 GENERATE_TOOL_SCHEMAS 会自动汇入 TOOL_SCHEMAS（模型可见），
// GENERATE_TOOL_NAMES 会让 executeTool 自动把这些工具路由到 execGenerateTool，
// GENERATE_WORKFLOW 会自动拼进系统提示。所以加一个工具 = 只在本文件加。
//
// 源站真名（务必用原名，见 chatcut-reverse/复刻规格-Agent工具与后端.md）：
//   submit_image / submit_video / submit_voice / submit_music / submit_sound
// 落地产物到时间线：ctx.commands.addMediaItem(asset) / addAsset(asset)。
// 详细分工、接线约定、验证 playbook 见仓库根 GPT-HANDOFF.md。
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

/** 生成类工具的 Anthropic schema。往这个数组里 push 即可（自动进模型可见工具列表）。 */
export const GENERATE_TOOL_SCHEMAS: Anthropic.Tool[] = [
  // 示例（删掉换成真的）：
  // {
  //   name: 'submit_image',
  //   description: 'Generate an image from a text prompt and add it to the timeline.',
  //   input_schema: {
  //     type: 'object',
  //     properties: { prompt: { type: 'string' }, track: { type: 'string', enum: ['V1', 'V2'] } },
  //     required: ['prompt'],
  //   },
  // },
];

/** 工具名集合，executeTool 用它把调用路由到这里（由上面的 schema 自动推导）。 */
export const GENERATE_TOOL_NAMES = new Set(GENERATE_TOOL_SCHEMAS.map((t) => t.name));

/** 执行一个生成类工具。返回 JSON 可序列化结果。产物落时间线走 ctx.commands.*。 */
export async function execGenerateTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  void args; // 真工具会用到 args / ctx —— 加 case 时直接用即可（这两行仅为通过 noUnusedParameters）
  void ctx;
  switch (name) {
    // case 'submit_image': { ... ctx.commands.addMediaItem(asset); return { ok: true }; }
    default:
      return { error: `generate tool not implemented: ${name}` };
  }
}

/** 系统提示里的「生成工作流」说明段（自动拼进 SYSTEM_PROMPT）。填你的工具用法指引。 */
export const GENERATE_WORKFLOW = '';
