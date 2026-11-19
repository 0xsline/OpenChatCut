import { makeDraft, replayActions } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { saveAutomaticVersion } from '../persist/versionStore';
import type { AgentContext } from './context';
import { buildOperation, partitionProposalActions, projectDocsDiffer } from './proposal';
import type { AgentTurn } from './useAgentRun';
import type { MutableValue } from './useAgentState';
import { isFailedToolResult } from './toolFailure';
import type { ServerRunDraftToolBody } from './serverRunDraftStore';
import type { ServerRunStart, ServerRunToolAction } from './serverRunProtocol';
import { revisionOf } from './external-edit-session';
import { policyForTool } from './execution-policy';
import {
  isFrozenVerdict,
  reconcileServerTool,
  type DraftToolEvidence,
  type DurableToolEvidence,
} from './serverRunToolReconcile';

type ProposalRecoveryRef = MutableValue<{ seenToolCalls: Set<string> }>;

export function serverRunDraftBaseChanged(
  baseDoc: ProjectDoc,
  currentDoc: ProjectDoc,
): boolean {
  return projectDocsDiffer(baseDoc, currentDoc);
}

export function turnContext(ctx: AgentContext, doc: ProjectDoc) {
  const draft = makeDraft(doc);
  return {
    draft,
    draftCtx: {
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: ctx.getCreativeMode,
      setCreativeMode: ctx.setCreativeMode,
      templates: ctx.templates,
      audio: ctx.audio,
      getProjectId: ctx.getProjectId,
      openProject: ctx.openProject,
      onProjectRenamed: ctx.onProjectRenamed,
      getUndoTarget: ctx.getUndoTarget,
      getRedoTarget: ctx.getRedoTarget,
      getApprovalMode: ctx.getApprovalMode,
      getOfflineMediaSrcs: ctx.getOfflineMediaSrcs,
    },
  };
}

export function applyToolActions(
  turn: AgentTurn,
  input: ServerRunToolAction,
  projectId: string,
): void {
  if (input.error !== undefined || isFailedToolResult(input.result) || !input.actions.length) return;
  const { persistent, proposed } = partitionProposalActions(input.actions);
  if (persistent.length) {
    const observed = turn.state.ctxRef.current.getDoc();
    if (!turn.persistentBeforeDoc) {
      turn.persistentBeforeDoc = turn.baseDoc;
      turn.persistentSnapshot = saveAutomaticVersion(projectId, 'Agent 修改前', turn.baseDoc).then(
        () => undefined,
        (error) => { turn.persistentSaveError = error; },
      );
    }
    // The proposal base already carries every import that has landed, so the live project
    // matching it means nobody else edited; comparing against the run's original base would
    // read the run's own landings as a foreign change and refuse its timeline edits.
    if (serverRunDraftBaseChanged(turn.proposalBaseDoc, observed)) turn.draftInvalidated = true;
    turn.proposalBaseDoc = replayActions(turn.proposalBaseDoc, persistent);
    turn.persistentOps.push(buildOperation(input.name, input.args, persistent));
  }
  if (proposed.length) {
    // Count tools that contributed proposal operations so the terminal path
    // can detect a run whose recorded edits failed to survive to settle time.
    turn.toolCallCount += 1;
    turn.ops.push(buildOperation(input.name, input.args, proposed));
  }
  const nextDoc = replayActions(turn.draft.getDoc(), input.actions);
  const next = turnContext(turn.state.ctxRef.current, nextDoc);
  turn.draft = next.draft;
  turn.draftCtx = next.draftCtx;
}

/**
 * Restores the draft, but decides per call whether its recorded actions may be
 * replayed. A `landed` marker is evidence, not proof: it is only honoured when
 * the revision it recorded still matches the live project. Anything else keeps
 * its evidence and pauses the run instead of guessing.
 *
 * `durable` is the server-side recovery view when the run has one; without it
 * (runs without durable tool records) this falls back to the previous behaviour.
 */
export function restoreToolActions(
  turn: AgentTurn,
  input: ServerRunStart,
  tools: readonly ServerRunDraftToolBody[],
  baseDoc: ProjectDoc,
  ref: ProposalRecoveryRef,
  projectId: string,
  durableByCall?: ReadonlyMap<string, DurableToolEvidence>,
): boolean {
  const liveDoc = turn.state.ctxRef.current.getDoc();
  const liveRevision = revisionOf(liveDoc);
  const baseRevision = revisionOf(baseDoc);
  const draftTools = tools.map(draftEvidence);
  const decisions = durableByCall ? tools.map((tool) => reconcileServerTool({
    toolCallId: tool.toolCallId,
    argsDigest: tool.argsDigest,
    name: tool.name,
    policy: policyForTool(tool.name, tool.args).recovery,
    durable: durableByCall.get(tool.toolCallId) ?? null,
    draft: draftEvidence(tool),
    draftTools,
    stored: tool.error !== undefined ? { error: tool.error }
      : Object.hasOwn(tool, 'result') ? { result: tool.result } : null,
    liveRevision,
    baseRevision,
  })) : [];
  const blocked = decisions.find((decision) => isFrozenVerdict(decision.verdict));
  if (blocked) {
    // Validate the complete draft before replaying any of its actions.
    freezeRunForReconcile(turn, input, blocked);
    return false;
  }
  // Calls whose edits already landed are in the live project; the ones after them are
  // replayed on top of it rather than on the run's original base.
  const anyLanded = tools.some((tool) => tool.landed);
  if (anyLanded) rebaseTurn(turn, liveDoc);
  for (const tool of tools) {
    ref.current.seenToolCalls.add(tool.toolCallId);
    if (tool.landed) {
      // The marker plus a matching revision (or a durable outcome) means the
      // edit is already in the live project.
      continue;
    }
    applyToolActions(turn, {
      runId: input.runId,
      toolCallId: tool.toolCallId,
      argsDigest: tool.argsDigest,
      name: tool.name,
      args: tool.args,
      ...(tool.error === undefined ? { result: tool.result } : { error: tool.error }),
      actions: [...tool.actions],
      baseDoc,
    }, projectId);
  }
  return true;
}

export function durableToolMap(
  tools: ServerRunStart['durableTools'],
): ReadonlyMap<string, DurableToolEvidence> | undefined {
  if (!tools) return undefined;
  return new Map(tools.map((tool) => [tool.toolCallId, {
    toolCallId: tool.toolCallId,
    argsDigest: tool.argsDigest,
    state: tool.state ?? 'intent',
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(tool.error === undefined ? {} : { error: tool.error }),
  }]));
}

function draftEvidence(tool: ServerRunDraftToolBody): DraftToolEvidence {
  return {
    toolCallId: tool.toolCallId,
    argsDigest: tool.argsDigest,
    name: tool.name,
    actions: tool.actions,
    ...(tool.landed ? { landed: true } : {}),
    ...(tool.landedRevision === undefined ? {} : { landedRevision: tool.landedRevision }),
  };
}

/**
 * Freezes a run whose browser-side write cannot be verified.
 *
 * The message names the operation and its target, and offers the two actions the
 * design requires: re-check the evidence, or end the task. Nothing is settled
 * here, and the draft is preserved, so re-checking has something to read.
 */
function freezeRunForReconcile(
  turn: AgentTurn,
  input: ServerRunStart,
  decision: { readonly reason?: string; readonly targets: readonly string[] },
): void {
  const reason = decision.reason ?? '无法确认上一次编辑是否已生效，已暂停后续写入。';
  turn.state.setMessages((messages) => [
    ...messages,
    {
      role: 'error',
      text: reason,
      reconcile: {
        reason,
        targets: [...decision.targets],
        evidenceVersion: 0,
      },
    },
  ]);
  // Stop the transport without settling: the run must stay open so its draft,
  // tool records and capability survive for a re-check.
  turn.state.abortRef.current?.abort(new Error('server run paused for reconciliation'));
  turn.state.runningRef.current = false;
  turn.state.setRunning(false);
  turn.completionStatus = 'awaiting_user';
  turn.state.setProposalStale?.(true);
  void input;
}

export function rebaseTurn(turn: AgentTurn, doc: ProjectDoc): void {
  const next = turnContext(turn.state.ctxRef.current, doc);
  turn.draft = next.draft;
  turn.draftCtx = next.draftCtx;
  turn.proposalBaseDoc = doc;
}
