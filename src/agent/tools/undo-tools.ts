// undo_last_change: Allow the Agent to respond to "undo the change just now".
//
// It does not touch the real history stack - that will invalidate the baseline of this round of draft (draft is a copy of the project,
// Replay according to the recorded action when the proposal is approved). Change to treat "the complete project snapshot of the previous step" as a normal
// The editor proposes it, proceed as usual propose→approve: users still read it first and then approve it, and rollback becomes a thing of the past.
// A normal step (it can be undone again).
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

/** Tool execution: Get undo target → proposed as whole project replacement. exported for verify. */
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
