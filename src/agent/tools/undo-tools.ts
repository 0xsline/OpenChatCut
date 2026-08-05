export { UNDO_TOOL_SCHEMAS, UNDO_TOOL_NAMES } from './schemas/undo-tools';
// undo_last_change / redo_last_change: respond to "undo" / "redo" without
// directly walking the live history stack (that would invalidate draft baselines).
// Instead apply the target ProjectDoc via applyDoc so propose→approve treats
// the rollback as a normal, still-undoable edit.
import type { AgentContext } from '../context';
import type { ProjectDoc } from '../../editor/types';

type HistoryCtx = Pick<AgentContext, 'commands' | 'getDoc' | 'getUndoTarget' | 'getRedoTarget'>;

function applyHistoryTarget(
  label: 'undo' | 'redo',
  target: ProjectDoc,
  ctx: HistoryCtx,
): unknown {
  const before = ctx.getDoc();
  ctx.commands.applyDoc(target);
  return {
    ok: true,
    restored: label === 'undo' ? 'previous project state' : 'redone project state',
    timelines: target.timelines.length,
    activeTimelineId: target.activeTimelineId,
    note: before.activeTimelineId !== target.activeTimelineId
      ? 'The active timeline also reverts to the one open in that snapshot.'
      : undefined,
  };
}

/** Tool execution: Get undo/redo target → proposed as whole project replacement. */
export function execUndoTool(name: string, ctx: HistoryCtx): unknown {
  if (name === 'undo_last_change') {
    if (!ctx.getUndoTarget) return { error: 'undo is unavailable in this session' };
    const target = ctx.getUndoTarget();
    if (!target) return { error: 'nothing to undo — no applied change in this session yet' };
    return applyHistoryTarget('undo', target, ctx);
  }
  if (name === 'redo_last_change') {
    if (!ctx.getRedoTarget) return { error: 'redo is unavailable in this session' };
    const target = ctx.getRedoTarget();
    if (!target) {
      return { error: 'nothing to redo — redo only works after undo, until a new edit clears the redo stack' };
    }
    return applyHistoryTarget('redo', target, ctx);
  }
  return { error: `unknown tool ${name}` };
}
