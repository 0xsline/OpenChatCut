// undo_last_change:让 Agent 能响应「撤销刚才那个改动」。
//
// 它不去动真实历史栈——那会让本轮 draft 的基线失效(draft 是工程副本,
// 提案批准时按记录的 action 重放)。改成把「上一步的完整工程快照」当作一次普通
// 编辑提出来,照常走 propose→approve:用户仍然先看后批,回滚也就成了历史里
// 正常的一步(自己还能再被撤销)。
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';

export const UNDO_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'undo_last_change',
    description: [
      'Revert the project to its state before the most recent applied change — use it when the user asks to undo,',
      'roll back, or take back the last edit. Proposed like any other edit, so the user still confirms it,',
      'and the revert itself stays undoable. It only reaches changes that were already APPLIED:',
      'edits still pending in the current proposal are dropped by rejecting that proposal, not with this tool.',
      'Call it once per undo step; to undo several steps, ask the user to confirm each.',
    ].join(' '),
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

export const UNDO_TOOL_NAMES = new Set(UNDO_TOOL_SCHEMAS.map((t) => t.name));

/** 工具执行:取撤销目标 → 作为整工程替换提出。exported for verify。 */
export function execUndoTool(
  name: string,
  ctx: Pick<AgentContext, 'commands' | 'getDoc' | 'getUndoTarget'>,
): unknown {
  if (name !== 'undo_last_change') return { error: `unknown tool ${name}` };
  if (!ctx.getUndoTarget) {
    return { error: 'undo is unavailable in this session' };
  }
  const target = ctx.getUndoTarget();
  if (!target) {
    return { error: 'nothing to undo — no applied change in this session yet' };
  }
  const before = ctx.getDoc();
  ctx.commands.applyDoc(target);
  const timelineCount = target.timelines.length;
  return {
    ok: true,
    restored: 'previous project state',
    timelines: timelineCount,
    activeTimelineId: target.activeTimelineId,
    note: before.activeTimelineId !== target.activeTimelineId
      ? 'The active timeline also reverts to the one open before that change.'
      : undefined,
  };
}
