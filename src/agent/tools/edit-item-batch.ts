import type { OpResult } from './edit-item-shared';

type Args = Record<string, unknown>;
export type EditItemBucket = 'adds' | 'updates' | 'deletes';

export interface EditItemOperation {
  bucket: EditItemBucket;
  index: number;
  entry: Record<string, unknown>;
}

interface AtomicBatchCallbacks<Draft> {
  createDraft: () => Draft;
  validate: (draft: Draft, operation: EditItemOperation) => OpResult;
  apply: (draft: Draft, plan: OpResult) => OpResult;
  /** One state replacement after every draft operation succeeds. */
  publish: (draft: Draft) => void;
}

const TOP_LEVEL_KEYS: Record<string, true> = {
  adds: true,
  updates: true,
  deletes: true,
  ripple: true,
  validateOnly: true,
  projectId: true,
};

function failedBatch(
  results: OpResult[],
  validateOnly: boolean,
  error: string,
): OpResult {
  return {
    ok: false,
    atomic: true,
    validateOnly,
    aborted: true,
    failed: 1,
    results,
    error,
    note: 'No draft was published. Fix the reported entry and retry the whole batch.',
  };
}

function collectOperations(args: Args): { operations?: EditItemOperation[]; error?: string } {
  const unknown = Object.keys(args).find((key) => !TOP_LEVEL_KEYS[key]);
  if (unknown) return { error: `unknown field "${unknown}" on edit_item` };
  const operations: EditItemOperation[] = [];
  for (const bucket of ['adds', 'updates', 'deletes'] as const) {
    const rawBucket = args[bucket];
    if (rawBucket !== undefined && !Array.isArray(rawBucket)) {
      return { error: `${bucket} must be an array` };
    }
    for (const [index, raw] of (rawBucket ?? []).entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: `${bucket}[${index}]: invalid ${bucket.slice(0, -1)} entry` };
      }
      operations.push({ bucket, index, entry: raw as Record<string, unknown> });
    }
  }
  return { operations };
}

/**
 * Apply one edit_item call to a private draft in request order, then publish once.
 * Validation and application failures discard the draft. validateOnly executes the
 * same draft path so later entries are checked against earlier planned changes.
 */
export function executeAtomicEditBatch<Draft>(
  args: Args,
  callbacks: AtomicBatchCallbacks<Draft>,
): OpResult {
  const validateOnly = args.validateOnly === true;
  if (validateOnly && args.ripple === true) {
    return { error: 'do not combine validateOnly with ripple' };
  }
  const collected = collectOperations(args);
  if (collected.error) return failedBatch([], validateOnly, collected.error);
  const operations = collected.operations!;
  if (!operations.length) {
    return {
      error: 'pass adds, updates, and/or deletes',
      hint: 'browse_library → edit_item adds:[{type:"effect"|"transition"|"motion-graphic"|"audio",...}]',
    };
  }

  const draft = callbacks.createDraft();
  const plans: OpResult[] = [];
  const results: OpResult[] = [];
  for (const operation of operations) {
    let plan: OpResult;
    try {
      plan = callbacks.validate(draft, operation);
    } catch (error) {
      const message = `${operation.bucket}[${operation.index}] validator failed: ${error instanceof Error ? error.message : String(error)}`;
      return failedBatch(plans, validateOnly, message);
    }
    if (plan.error) {
      const error = String(plan.error);
      const prefixed = error.startsWith(`${operation.bucket}[`)
        ? error
        : `${operation.bucket}[${operation.index}]: ${error}`;
      const failed = { ...plan, error: prefixed };
      return failedBatch([...plans, failed], validateOnly, prefixed);
    }
    plans.push(plan);
    let result: OpResult;
    try {
      result = callbacks.apply(draft, plan);
    } catch (error) {
      const message = `${operation.bucket}[${operation.index}] apply failed: ${error instanceof Error ? error.message : String(error)}`;
      return failedBatch(results, validateOnly, message);
    }
    if (result.error) {
      const error = `${operation.bucket}[${operation.index}] apply failed: ${String(result.error)}`;
      return failedBatch([...results, { ...result, error }], validateOnly, error);
    }
    results.push(result);
  }

  if (validateOnly) {
    return {
      ok: true,
      atomic: true,
      validateOnly: true,
      wouldApply: plans.length,
      results: plans.map((plan) => ({ ok: true, kind: plan.kind, plan: plan.plan, preview: plan })),
    };
  }

  try {
    callbacks.publish(draft);
  } catch (error) {
    const message = `final publish failed: ${error instanceof Error ? error.message : String(error)}`;
    return failedBatch(results, false, message);
  }
  return {
    ok: true,
    atomic: true,
    validateOnly: false,
    ripple: args.ripple === true,
    results,
  };
}
