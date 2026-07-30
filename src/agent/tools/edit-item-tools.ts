export { EDIT_ITEM_TOOL_SCHEMAS, EDIT_ITEM_TOOL_NAMES } from './schemas/edit-item-tools';
import type { AgentContext } from '../context';
import { commitPlan } from './edit-item-commit';
import type { Args, OpResult } from './edit-item-shared';
import { validateAdd, validateDelete, validateUpdate } from './edit-item-validate';

type Entry = Record<string, unknown>;
type Validator = (ctx: AgentContext, entry: Entry) => OpResult;

function validateBucket(
  bucket: string,
  values: unknown[],
  validator: Validator,
  ctx: AgentContext,
): OpResult[] {
  return values.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      return { error: `${bucket}[${index}]: invalid ${bucket.slice(0, -1)} entry` };
    }
    const result = validator(ctx, raw as Entry);
    if (!result.error) return result;
    const error = String(result.error);
    return {
      ...result,
      error: error.startsWith(`${bucket}[`) ? error : `${bucket}[${index}]: ${error}`,
    };
  });
}

function validateBatch(args: Args, ctx: AgentContext): OpResult[] {
  const adds = Array.isArray(args.adds) ? args.adds : [];
  const updates = Array.isArray(args.updates) ? args.updates : [];
  const deletes = Array.isArray(args.deletes) ? args.deletes : [];
  return [
    ...validateBucket('adds', adds, validateAdd, ctx),
    ...validateBucket('updates', updates, validateUpdate, ctx),
    ...validateBucket('deletes', deletes, validateDelete, ctx),
  ];
}

function failedBatch(plans: OpResult[], validateOnly: boolean): OpResult {
  const failed = plans.filter((plan) => plan.error);
  return {
    ok: false,
    atomic: true,
    validateOnly,
    aborted: true,
    failed: failed.length,
    results: plans,
    error: String(failed[0]!.error),
    note: 'No mutations applied (atomic batch). Fix errors and retry. Use only supported fields from the edit_item schema.',
  };
}

export async function execEditItemTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  const validateOnly = args.validateOnly === true;
  const ripple = args.ripple === true;
  if (validateOnly && ripple) return { error: 'do not combine validateOnly with ripple' };
  const plans = validateBatch(args, ctx);
  if (!plans.length) {
    return {
      error: 'pass adds, updates, and/or deletes',
      hint: 'browse_library → edit_item adds:[{type:"effect"|"transition"|"motion-graphic"|"audio",...}]',
    };
  }
  if (plans.some((plan) => plan.error)) return failedBatch(plans, validateOnly);
  if (validateOnly) {
    return {
      ok: true,
      atomic: true,
      validateOnly: true,
      wouldApply: plans.length,
      results: plans.map((plan) => ({ ok: true, kind: plan.kind, plan: plan.plan, preview: plan })),
    };
  }
  const results = plans.map((plan) => commitPlan(ctx, plan, ripple));
  const failed = results.filter((result) => result.error);
  return {
    ok: failed.length === 0,
    atomic: true,
    validateOnly: false,
    ripple,
    results,
    ...(failed.length ? { failed: failed.length } : {}),
  };
}
