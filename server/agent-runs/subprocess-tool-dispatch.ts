import type { ModelMessage } from 'ai';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent';
type ToolCall = Pick<Extract<CodexTurnStreamEvent, { type: 'tool-start' }>, 'callId' | 'name' | 'args'>;
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { codexToolHistoryEntry } from '../../src/agent/codex/tool-history';
import { toolExecutionMode } from '../../src/agent/tools/execution-modes';
import { policyForTool } from '../../src/agent/execution-policy';
import { isFailedToolResult, toolFailureReason } from '../../src/agent/toolFailure';
import { recordAcceptedTool } from './acceptance-loop';
import { executeBrowserTool } from './browser-tool';
import { digestToolArgs } from './store';
import { RunRecoveryFault, asRecoveryFault, isRunRecoveryFault as isRecoveryFault } from './run-recovery-fault';
import type { ServerCodexTurnInput } from './codex-turn';

/** One RPC owns its callbacks and queue through durable outcome settlement. */
export function createSubprocessToolDispatcher(
  input: Pick<ServerCodexTurnInput, 'run' | 'activation' | 'signal' | 'recovery' | 'resumeFrom'>,
  schemas: readonly AgentToolSchema[],
  toolHistory: ModelMessage[] | undefined,
  options: { readonly structuredReplay?: boolean; readonly onToolBoundary?: () => void } = {},
) {
  const recovery = input.recovery;
  const resume = input.resumeFrom;
  let open = true;
  const dispatched = new Set<string>();
  const assertOpen = () => {
    if (open && !input.signal.aborted) return;
    if (isRecoveryFault(input.signal.reason)) throw input.signal.reason;
    throw recovery
      ? new RunRecoveryFault('outcome-unknown', 'Agent tool callback belongs to a closed request.')
      : new Error('Agent tool callback belongs to a closed request.');
  };
  let recoveryFault: unknown = null;
  let toolTail = Promise.resolve();
  const reusedOperations = new Set<number>();
  const unmatchedWrites = new Set(options.structuredReplay ? resume?.completedTools
    .filter((tool) => policyForTool(tool.name, tool.args ?? {}).effect !== 'read')
    .map((tool) => tool.opSeq) : []);
  const recoveryOpLimit = resume?.throughOpSeq ?? Math.max(0, ...(resume?.completedTools ?? []).map((tool) => tool.opSeq));
  const dispatchTool = async (call: ToolCall): Promise<unknown> => {
    assertOpen();
    const schema = schemas.find((candidate) => candidate.name === call.name);
    if (!schema) {
      const failure = { error: `Unknown tool: ${call.name}` };
      input.activation.toolFailures.record(call.name, { success: false, result: failure });
      toolHistory?.push(codexToolHistoryEntry(call, { success: false, result: failure }));
      return failure;
    }
    const args = (call.args ?? {}) as Record<string, unknown>;
    const argsDigest = digestToolArgs(args);
    // Only operations already present in this interrupted request can be
    // recovery matches. Fresh reads and later requests retain their semantics.
    const write = policyForTool(call.name, args).effect !== 'read';
    const sameRead = resume && options.structuredReplay && !write
      ? resume.completedTools.find((tool) => tool.toolCallId === call.callId) : undefined;
    if (sameRead && (sameRead.name !== call.name || sameRead.argsDigest !== argsDigest)) {
      throw new RunRecoveryFault('outcome-unknown', 'The replayed tool ID refers to a different operation.');
    }
    if (resume && (write || sameRead)) {
      if (!recovery?.lookupTool) {
        throw new RunRecoveryFault('outcome-unknown', 'Agent recovery operation evidence is unavailable.');
      }
      let prior;
      try {
        prior = sameRead ? { ...sameRead, state: 'outcome' as const, ambiguous: false } : await recovery.lookupTool({
          name: call.name, argsDigest,
          requestIndex: resume.requestIndex, throughOpSeq: recoveryOpLimit,
        });
      } catch (error) {
        throw asRecoveryFault(error);
      }
      assertOpen();
      // API partial rounds lack a complete signed assistant/tool response.
      // Replaying that request can change an already executed write's args;
      // without an exact old intent/outcome this is ambiguous execution.
      if (write && unmatchedWrites.size && prior?.state !== 'outcome') {
        throw new RunRecoveryFault('outcome-unknown', 'The replay requests a different write before accounting for confirmed edits.');
      }
      if (prior?.ambiguous || (prior && reusedOperations.has(prior.opSeq))) {
        throw new RunRecoveryFault('outcome-unknown', `Agent tool ${call.name} has ambiguous repeated recovery intent.`);
      }
      if (prior?.state === 'claimed') {
        throw new RunRecoveryFault('outcome-unknown', `Agent tool ${prior.toolCallId} still needs reconciliation.`);
      }
      if (prior?.state === 'outcome') {
        reusedOperations.add(prior.opSeq);
        unmatchedWrites.delete(prior.opSeq);
        const success = prior.success === true;
        const shaped = input.activation.current.withToolResult(call.name, prior.result);
        input.activation.current = shaped.activation;
        input.activation.toolFailures.record(call.name, { success, result: prior.result });
        toolHistory?.push(codexToolHistoryEntry(call, { success, result: prior.result }));
        if (!success) throw new Error(toolFailureReason(prior.result));
        input.activation.acceptance = recordAcceptedTool(input.activation.acceptance, policyForTool(call.name, args).effect);
        return prior.result ?? null;
      }
    }
    let opSeq = 0;
    if (recovery) {
      // Intent lands BEFORE the request is published: without it the server
      // can never prove whether the browser was granted execution authority.
      try {
        options.onToolBoundary?.();
        const reserved = await recovery.beginTool({
          toolCallId: call.callId,
          name: call.name,
          argsDigest,
          args,
        });
        opSeq = reserved.opSeq;
      } catch (error) {
        throw asRecoveryFault(error);
      }
    }
    assertOpen();
    let delivered: unknown;
    let local = true;
    let businessError: unknown = null;
    try {
      delivered = await executeBrowserTool(
        input.run,
        schema,
        args,
        call.callId,
        input.activation,
        {
          beforeExecute: () => { assertOpen(); if (recoveryFault) throw recoveryFault; },
          beforeResult: assertOpen,
          onBrowserDispatch: () => { assertOpen(); options.onToolBoundary?.(); local = false; dispatched.add(call.callId); },
        },
      );
    } catch (error) {
      if (isRecoveryFault(error)) throw error;
      // A timeout/cancellation does not prove what the browser applied. Only a
      // settled request or a local rejection can become a confirmed failure.
      if (recovery && !local && input.run.toolRequests.get(call.callId)?.status !== 'settled') {
        throw new RunRecoveryFault('outcome-unknown', `Agent tool ${call.callId} has no confirmed browser result.`);
      }
      businessError = error;
      delivered = { error: toolFailureReason(error) };
    }
    assertOpen();
    const success = !businessError && !isFailedToolResult(delivered);
    if (recovery) {
      try {
        await recovery.finishTool({
          opSeq,
          toolCallId: call.callId,
          name: call.name,
          argsDigest,
          success,
          result: delivered ?? null,
          local,
        });
      } catch (error) {
        throw asRecoveryFault(error);
      }
    }
    assertOpen();
    dispatched.delete(call.callId);
    toolHistory?.push(codexToolHistoryEntry(call, { success, result: delivered }));
    if (businessError) throw businessError;
    return delivered ?? null;
  };
  const executeTool = async (call: ToolCall): Promise<unknown> => {
    // Keep exclusive calls queued through WAL settlement. Releasing when the
    // browser answers would let a waiting write run before a failed outcome
    // write freezes this RPC.
    let release: (() => void) | undefined;
    if (recovery && toolExecutionMode(call.name, (call.args ?? {}) as Record<string, unknown>) !== 'parallel') {
      const previous = toolTail;
      const next = Promise.withResolvers<void>();
      toolTail = next.promise;
      release = next.resolve;
      await previous;
    }
    try {
      assertOpen();
      if (recoveryFault) throw recoveryFault;
      return await dispatchTool(call);
    } catch (error) {
      if (isRecoveryFault(error)) recoveryFault = error;
      throw error;
    } finally {
      release?.();
    }
  };

  return {
    executeTool,
    get hasUnmatchedWrites() { return unmatchedWrites.size > 0; },
    get fault() { return recoveryFault; },
    get hasUnconfirmedTools() { return dispatched.size > 0; },
    close() {
      open = false;
      // Cancel only requests this RPC dispatched. Queued callbacks wake and
      // fail their scope guard before they can publish another tool request.
      for (const callId of dispatched) {
        const request = input.run.toolRequests.get(callId);
        if (request?.status !== 'pending') continue;
        request.status = 'cancelled';
        clearTimeout(request.timeout);
        request.timeout = undefined;
        request.reject(new Error('Agent subprocess request closed.'));
      }
    },
  };
}
