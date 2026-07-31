export { EDIT_ITEM_TOOL_SCHEMAS, EDIT_ITEM_TOOL_NAMES } from './schemas/edit-item-tools';
import type { AgentContext } from '../context';
import { makeDraft } from '../../editor/store';
import type { DraftEngine } from '../../editor/store';
import { executeAtomicEditBatch } from './edit-item-batch';
import type { EditItemOperation } from './edit-item-batch';
import { commitPlan } from './edit-item-commit';
import type { Args, OpResult } from './edit-item-shared';
import { validateAdd, validateDelete, validateUpdate } from './edit-item-validate';

interface EditItemDraft {
  engine: DraftEngine;
  context: AgentContext;
}

function validateOperation(draft: EditItemDraft, operation: EditItemOperation): OpResult {
  if (operation.bucket === 'adds') return validateAdd(draft.context, operation.entry);
  if (operation.bucket === 'updates') return validateUpdate(draft.context, operation.entry);
  return validateDelete(draft.context, operation.entry);
}

export async function execEditItemTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  const ripple = args.ripple === true;
  return executeAtomicEditBatch<EditItemDraft>(args, {
    createDraft: () => {
      const engine = makeDraft(ctx.getDoc());
      return {
        engine,
        context: {
          ...ctx,
          commands: engine.commands,
          getState: engine.getState,
          getDoc: engine.getDoc,
        },
      };
    },
    validate: validateOperation,
    apply: (draft, plan) => commitPlan(draft.context, plan, ripple),
    publish: (draft) => ctx.commands.applyDoc(draft.engine.getDoc()),
  });
}
