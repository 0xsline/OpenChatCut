import type { ModelMessage } from 'ai';
import type { ToolEffect } from '../../src/agent/execution-policy';
import {
  normalizeAcceptanceIterations,
} from '../../src/agent/settings/agentSettings';

export interface AcceptanceLoopState {
  readonly enabled: boolean;
  readonly maxIterations: number;
  readonly phase: 'working' | 'checking';
  readonly iteration: number;
  readonly mutated: boolean;
  readonly verifiedAfterMutation: boolean;
}

export type AcceptanceDecision =
  | { readonly action: 'finish'; readonly state: AcceptanceLoopState; readonly status?: 'passed' }
  | { readonly action: 'continue'; readonly state: AcceptanceLoopState; readonly message: ModelMessage }
  | { readonly action: 'fail'; readonly state: AcceptanceLoopState; readonly reason: string };

export function createAcceptanceLoop(enabled: boolean, maxIterations: number): AcceptanceLoopState {
  return {
    enabled,
    maxIterations: normalizeAcceptanceIterations(maxIterations),
    phase: 'working',
    iteration: 0,
    mutated: false,
    verifiedAfterMutation: false,
  };
}

export function recordAcceptedTool(
  state: AcceptanceLoopState,
  effect: ToolEffect,
): AcceptanceLoopState {
  if (!state.enabled) return state;
  if (effect === 'read') {
    return state.phase === 'checking' && state.mutated
      ? { ...state, verifiedAfterMutation: true }
      : state;
  }
  return { ...state, mutated: true, verifiedAfterMutation: false };
}

function acceptanceMessage(iteration: number, maxIterations: number): ModelMessage {
  return {
    role: 'user',
    content: [
      `<autonomous_acceptance iteration="${iteration}" max="${maxIterations}">`,
      'Inspect the latest editor state against the original user request before finishing.',
      'Use read_project, read_timeline, and the relevant inspect/probe/progress tools to verify actual results after the last edit.',
      'Fix any issue you find, then verify again. Ask the user only when a required fact cannot be inferred.',
      'When the result passes, give one concise final summary with the checks performed.',
      '</autonomous_acceptance>',
    ].join('\n'),
  } as ModelMessage;
}

export function decideAcceptanceAfterTurn(state: AcceptanceLoopState): AcceptanceDecision {
  if (!state.enabled || !state.mutated) return { action: 'finish', state };
  if (state.phase === 'checking' && state.verifiedAfterMutation) {
    return { action: 'finish', state, status: 'passed' };
  }
  if (state.iteration >= state.maxIterations) {
    return {
      action: 'fail',
      state,
      reason: `Autonomous acceptance did not verify the latest edit within ${state.maxIterations} iterations.`,
    };
  }
  const next = {
    ...state,
    phase: 'checking' as const,
    iteration: state.iteration + 1,
  };
  return {
    action: 'continue',
    state: next,
    message: acceptanceMessage(next.iteration, next.maxIterations),
  };
}

export function acceptanceInstructions(enabled: boolean): string {
  return enabled
    ? '\n\n# Autonomous acceptance\n- The runtime will request a settled verification pass after edits. Treat it as the same task.\n- Do not ask for confirmation unless a required fact is missing. Verify the latest state with tools after the final edit before reporting completion.'
    : '';
}

export type TurnDisposition = 'continue' | 'completed' | 'failed' | 'max-tokens';
export function turnDisposition(
  hitMaxTokens: boolean,
  continued: boolean,
  hasUnresolvedFailure = false,
): TurnDisposition {
  if (hitMaxTokens) return hasUnresolvedFailure ? 'failed' : 'max-tokens';
  if (continued) return 'continue';
  return hasUnresolvedFailure ? 'failed' : 'completed';
}
