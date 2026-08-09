import type { ModelMessage } from 'ai';
import { remainingInputBudgetTokens } from './context-compaction';

const MAX_LOAD_SKILL_RESULT_CHARS = 64_000;

/** Ephemeral request context for low-level tools; never persisted in ProjectDoc. */
export interface HarnessToolExecutionContext {
  readonly loadSkillResultBudgetChars?: number;
}

export interface ActiveModelRoundContext {
  readonly messages: readonly ModelMessage[];
  readonly system: string;
  readonly toolSchemas: readonly unknown[];
  readonly contextWindowTokens: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Budget one UTF-16 code unit per remaining token. This uses the estimator's
 * conservative non-ASCII ratio, so a returned page cannot consume more room.
 */
export function harnessContextForModelRound(
  round: ActiveModelRoundContext,
): HarnessToolExecutionContext {
  const remaining = remainingInputBudgetTokens(round);
  return {
    loadSkillResultBudgetChars: Math.min(MAX_LOAD_SKILL_RESULT_CHARS, remaining),
  };
}
