import type { AnyAction } from '../editor/store';
import type { ToolRecoveryPolicy } from './execution-policy';

/**
 * Reconciliation of browser-side effects after a restart.
 *
 * Three facts must never be conflated: a draft artifact proves an edit was
 * *intended*, a landed marker proves it was *committed locally*, and a durable
 * tool outcome proves the server *received* a result. Only the last one lets the
 * model continue; the others decide whether the operation may be replayed.
 *
 * The table this implements is the design note's §4.1:
 *
 * | evidence                                  | action                        |
 * |-------------------------------------------|-------------------------------|
 * | durable outcome matching this call        | reuse the existing result      |
 * | intent with no claim ever granted         | may re-dispatch once           |
 * | claim granted, browser has a result       | submit that result             |
 * | claim granted, only "started" + actions   | verify; else freeze writes     |
 * | (nothing at all)                          | never executed, dispatch       |
 *
 * A new model call id never re-authorises a write: identity is the operation,
 * not the call the model happened to make this time.
 */

export type DurableToolState = 'outcome' | 'claimed' | 'intent';

export interface DurableToolEvidence {
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly state: DurableToolState;
  readonly result?: unknown;
  readonly error?: string;
}

export interface DraftToolEvidence {
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly name: string;
  readonly actions: readonly AnyAction[];
  /** Auto-apply marked the call as committed to the live project. */
  readonly landed?: boolean;
  /** The project revision observed when this call landed. */
  readonly landedRevision?: string;
}

export interface ServerToolReconcileInput {
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly name: string;
  readonly policy: ToolRecoveryPolicy;
  readonly durable: DurableToolEvidence | null;
  readonly draft: DraftToolEvidence | null;
  /** Ordered run draft, needed to identify the last verified live baseline. */
  readonly draftTools?: readonly DraftToolEvidence[];
  /** Browser-side stored outcome from a previous attempt of this same call. */
  readonly stored: { readonly result?: unknown; readonly error?: string } | null;
  /** Live project revision, so a landed marker can be checked, not trusted. */
  readonly liveRevision: string;
  /** Revision the run's draft base was captured at. */
  readonly baseRevision: string;
}

export type ServerToolReconcileVerdict =
  /** The server already has a verified outcome; deliver it, do not execute. */
  | 'reuse-result'
  /** No execution authority was ever granted; the operation may run once. */
  | 'redispatch'
  /** A result exists somewhere trustworthy; submit it as this call's outcome. */
  | 'submit-existing-result'
  /** A write whose effect cannot be verified: freeze further writes, keep evidence. */
  | 'outcome-unknown'
  /** A confirmed business failure; it is an answer, not a blocked write. */
  | 'confirmed-failure';

export interface ServerToolReconcileDecision {
  readonly verdict: ServerToolReconcileVerdict;
  /** Human-facing reason, used verbatim in the frozen-write prompt. */
  readonly reason?: string;
  readonly result?: unknown;
  /** Targets this operation touches, so the freeze message can name them. */
  readonly targets: readonly string[];
}

function targetsOf(input: ServerToolReconcileInput): string[] {
  const fromActions = (input.draft?.actions ?? []).flatMap((action) => {
    const record = action as unknown as Record<string, unknown>;
    const target = record.itemId ?? record.id ?? record.trackId ?? record.assetId;
    return typeof target === 'string' && target ? [target] : [];
  });
  const unique = [...new Set(fromActions)];
  return unique.length ? unique.slice(0, 3) : [];
}

function isPureRead(policy: ToolRecoveryPolicy): boolean {
  return policy === 'pure' || policy === 'resume';
}

export function reconcileServerTool(
  input: ServerToolReconcileInput,
): ServerToolReconcileDecision {
  const targets = targetsOf(input);
  const durable = input.durable;
  if (durable && durable.argsDigest !== input.argsDigest) {
    // The durable record describes a different invocation of this call id. It
    // cannot authorise this one, and it must not be silently overwritten.
    return {
      verdict: 'outcome-unknown',
      reason: `工具 ${input.name} 的参数与已记录的操作不一致，无法确认哪一次已生效。`,
      targets,
    };
  }

  if (input.draft && !input.draft.landed && input.draft.actions.length > 0) {
    const tools = input.draftTools ?? [];
    const lastLanded = tools.findLastIndex((tool) => tool.landed === true);
    const currentIndex = tools.findIndex((tool) => tool.toolCallId === input.toolCallId);
    const baseline = lastLanded < 0 ? input.baseRevision : tools[lastLanded]?.landedRevision;
    // A saved result confirms tool execution, but the draft artifact precedes
    // the live commit and its landing marker. Missing markers leave a second
    // commit window, even when the server has already acknowledged the result.
    if (baseline === undefined || baseline !== input.liveRevision
      || (lastLanded >= 0 && currentIndex >= 0 && currentIndex < lastLanded)) {
      return {
        verdict: 'outcome-unknown',
        reason: `工具 ${input.name} 的草稿编辑缺少落地标记，无法确认当前工程是否仍处于可安全重放的基线。无法确认对${targets.length ? ` ${targets.join('、')} ` : '目标片段'}的编辑是否已生效，已暂停后续写入。`,
        targets,
      };
    }
  }

  // 1. A durable outcome is the only evidence that lets the model continue.
  if (durable?.state === 'outcome') {
    if (durable.error !== undefined) {
      return {
        verdict: 'confirmed-failure',
        reason: durable.error,
        targets,
      };
    }
    return { verdict: 'reuse-result', result: durable.result, targets };
  }

  // 2. No execution authority was ever handed out: the operation never ran, so
  //    replaying it cannot double-apply.
  if (!durable || durable.state === 'intent') {
    return { verdict: input.stored ? 'submit-existing-result' : 'redispatch', targets };
  }

  // 3. A claim was granted. From here on the question is what the browser did
  //    with that authority.
  if (input.stored?.error !== undefined) {
    return { verdict: 'confirmed-failure', reason: input.stored.error, targets };
  }
  if (input.stored !== null && Object.hasOwn(input.stored, 'result')) {
    // The browser produced a result for exactly this call; submitting it is the
    // reconciliation, not a new execution.
    return { verdict: 'submit-existing-result', result: input.stored.result, targets };
  }
  if (isPureRead(input.policy)) {
    // Reads are safe to repeat: nothing outside the browser's own state changed.
    return { verdict: 'redispatch', targets };
  }
  if (input.draft?.landed) {
    // A landed marker claims the edits are in the live project. Trust it only
    // against a revision we can compare: the marker plus an unchanged project
    // proves the landing happened, anything else needs a human.
    if (input.draft.landedRevision !== undefined
      && input.draft.landedRevision === input.liveRevision) {
      return {
        verdict: 'outcome-unknown',
        reason: `工具 ${input.name} 标记为已落地，但服务端没有收到结果。`,
        targets,
      };
    }
    return {
      verdict: 'outcome-unknown',
      reason: input.draft.landedRevision === undefined
        ? `工具 ${input.name} 声称改动已落地，但没有可核对的项目版本。`
        : `工具 ${input.name} 落地后工程又被修改过，无法判断改动是否仍然生效。`,
      targets,
    };
  }
  return {
    verdict: 'outcome-unknown',
    reason: `无法确认对${targets.length ? ` ${targets.join('、')} ` : '目标片段'}的编辑是否已生效，已暂停后续写入。`,
    targets,
  };
}

export function isFrozenVerdict(verdict: ServerToolReconcileVerdict): boolean {
  return verdict === 'outcome-unknown';
}
