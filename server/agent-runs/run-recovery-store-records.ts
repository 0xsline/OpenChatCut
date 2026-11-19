import { join } from 'node:path';
import { runtimeProfile } from '../runtime-profile.ts';
import type { ModelMessage } from 'ai';
import { decodeApiRecoveryMessages } from './api-recovery-messages';
import type { PersistedToolFailure } from '../../src/agent/toolFailure';
import type { ActivationState } from './browser-tool';
import type { ServerRunInput } from './executor';
import type { ServerRunToolIntent } from './run-recovery-contract.ts';

/** Durable recovery is shared by API and the Codex subprocess backend. */
export function supportsDurableRunRecovery(backend: unknown): backend is 'codex' | 'api' {
  return backend === 'codex' || backend === 'api';
}

export const RUN_RECOVERY_DB_FILENAME = 'run-recovery-v1.sqlite3';
export const RUN_RECOVERY_DB_ENV = 'OPENCHATCUT_RUN_RECOVERY_DB';
export const RUN_RECOVERY_SCHEMA_VERSION = 4;

export const MAX_RUN_RECOVERY_RUNS = 128;
export const MAX_RUN_RECOVERY_TOOLS_PER_RUN = 4_096;
export const MAX_RUN_RECOVERY_REQUEST_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RUN_OWNER_TTL_MS = 30_000;

export type RunRecoveryPhase =
  | 'admitted'
  | 'paused'
  | 'executing'
  | 'needs_reconcile'
  | 'finalizing'
  | 'finalized';

export type RunToolState = 'intent' | 'claimed' | 'outcome';

export interface RunRecoveryKey {
  readonly projectId: string;
  readonly sessionGeneration: string;
  readonly runId: string;
}

export interface RunToolRecoveryRow extends ServerRunToolIntent {
  readonly requestIndex: number;
  readonly ambiguous?: boolean;
  readonly state: RunToolState;
  readonly claimId?: string;
  readonly success?: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export type RunRecoveryExecutionInput = Omit<ServerRunInput, 'origin' | 'tools'> & {
  readonly toolNames: readonly string[];
  readonly references: readonly unknown[];
};

export interface RecoveryRequestOptions { readonly maxOutputTokens: number; }
export interface RecoveryCompletion { readonly status: 'completed' | 'awaiting-user'; readonly text: string; }

export interface RunRecoveryAttempt {
  readonly attemptNumber: number;
  readonly continuationId: string | null;
  readonly message: string | null;
  readonly messageDigest: string | null;
  readonly status: 'executing' | 'paused' | 'completed' | 'cancelled';
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly error: string | null;
}

export type RunContinuationOutcome = 'accepted' | 'duplicate' | 'conflict' | 'unknown-run'
  | 'run-finalized' | 'epoch-stale' | 'revision-stale' | 'unresolved-claims'
  | 'not-paused' | 'invalid-continuation' | 'missing-checkpoint';

export interface RunRecoveryRun {
  readonly key: RunRecoveryKey;
  readonly backend: string;
  readonly model: string;
  readonly askOnly: boolean;
  readonly phase: RunRecoveryPhase;
  readonly attemptNumber: number;
  readonly lastError: string | null;
  readonly lastContinuationId: string | null;
  readonly attempts: readonly RunRecoveryAttempt[];
  readonly reconcileReason: string | null;
  readonly revision: number;
  readonly admittedAt: number;
  readonly admissionExpiresAt: number;
  readonly requestIndex: number;
  readonly requestState: 'pending' | 'inflight';
  readonly requestOpBoundary: number;
  readonly requestOptions: RecoveryRequestOptions | null;
  readonly completion: RecoveryCompletion | null;
  readonly prompt: string | null;
  readonly messages: readonly ModelMessage[] | null;
  readonly toolNames: readonly string[] | null;
  readonly completedThroughOpSeq: number;
  readonly nextOpSeq: number;
  readonly ownerInstance: string | null;
  readonly ownerEpoch: number;
  readonly ownerExpiresAt: number | null;
  readonly finalizedAt: number | null;
  readonly executionInput: RunRecoveryExecutionInput | null;
  readonly instructions: string | null;
  readonly executionState: {
    activeToolNames: string[];
    acceptance: unknown;
    toolFailures?: PersistedToolFailure[];
    lastSuccessfulPureTool?: ActivationState['lastSuccessfulPureTool'];
  } | null;
  readonly tools: readonly RunToolRecoveryRow[];
}

export type RunAdmissionOutcome =
  | 'admitted'
  | 'duplicate'
  | 'identity-conflict'
  | 'unsupported-backend'
  | 'over-capacity';

export type RunClaimRecoveryOutcome =
  | 'claimed'
  | 'duplicate'
  | 'already-claimed'
  | 'unknown-tool'
  | 'mismatch'
  | 'epoch-stale'
  | 'run-finalized';

export type RunOutcomeWrite =
  | 'recorded'
  | 'duplicate'
  | 'conflict'
  | 'unknown-tool'
  | 'unclaimed'
  | 'epoch-stale'
  | 'run-finalized';

export type RunOwnershipOutcome =
  | 'acquired'
  | 'renewed'
  | 'held-elsewhere'
  | 'run-finalized'
  | 'unknown-run'
  | 'revision-stale';

export interface RunAdmissionInput extends RunRecoveryKey {
  readonly backend: string;
  readonly model: string;
  readonly askOnly: boolean;
  /** Absolute deadline of the unanswered create admission, in epoch millis. */
  readonly admissionExpiresAt: number;
  readonly now?: number;
  readonly executionInput?: RunRecoveryExecutionInput;
}

export class RunRecoverySchemaError extends Error {
  readonly code = 'run-recovery-schema-unsupported';
  readonly foundVersion: number;
  constructor(foundVersion: number) {
    super(`Agent run recovery database schema version ${foundVersion} is not supported (expected ${RUN_RECOVERY_SCHEMA_VERSION}).`);
    this.name = 'RunRecoverySchemaError';
    this.foundVersion = foundVersion;
  }
}

export class RunRecoveryLimitError extends Error {
  readonly code = 'run-recovery-limit';
  constructor(message: string) {
    super(message);
    this.name = 'RunRecoveryLimitError';
  }
}

export function defaultRunRecoveryStorePath(): string {
  const override = process.env[RUN_RECOVERY_DB_ENV]?.trim();
  if (override) return override;
  // Sits beside project-store-v1/ but outside it: the JSON project store scans
  // its own directory and must never see a foreign file.
  return join(runtimeProfile().rootDir, RUN_RECOVERY_DB_FILENAME);
}

export interface RunRow {
  project_id: string;
  session_generation: string;
  run_id: string;
  backend: string;
  model: string;
  ask_only: number;
  phase: string;
  attempt_number: number;
  last_error: string | null;
  last_continuation_id: string | null;
  reconcile_reason: string | null;
  revision: number;
  admitted_at: number;
  admission_expires_at: number;
  request_index: number;
  request_state: string;
  request_op_boundary: number;
  request_options: string | null;
  completion: string | null;
  prompt: string | null;
  messages: string | null;
  tool_names: string | null;
  completed_through_op_seq: number;
  next_op_seq: number;
  body_bytes: number;
  owner_instance: string | null;
  owner_epoch: number;
  owner_expires_at: number | null;
  finalized_at: number | null;
  execution_input: string | null;
  instructions: string | null;
  execution_state: string | null;
}

export interface ToolRow {
  request_index: number;
  args: string | null;
  op_seq: number;
  tool_call_id: string;
  name: string;
  args_digest: string;
  state: string;
  claim_id: string | null;
  success: number | null;
  result: string | null;
  model_result: string | null;
  error: string | null;
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function decodeExecutionInput(row: RunRow): RunRecoveryExecutionInput | null {
  const input = parseJson<RunRecoveryExecutionInput & { messages: unknown }>(row.execution_input);
  if (!input) return null;
  if (typeof input.messages === 'string') {
    return { ...input, messages: decodeApiRecoveryMessages(input.messages) };
  }
  return input;
}

export function toRun(row: RunRow, tools: readonly ToolRow[], attempts: readonly RunRecoveryAttempt[] = []): RunRecoveryRun {
  return {
    key: {
      projectId: row.project_id,
      sessionGeneration: row.session_generation,
      runId: row.run_id,
    },
    backend: row.backend,
    model: row.model,
    askOnly: row.ask_only === 1,
    phase: row.phase as RunRecoveryPhase,
    attemptNumber: row.attempt_number,
    lastError: row.last_error,
    lastContinuationId: row.last_continuation_id,
    attempts,
    reconcileReason: row.reconcile_reason,
    revision: row.revision,
    admittedAt: row.admitted_at,
    admissionExpiresAt: row.admission_expires_at,
    requestIndex: row.request_index,
    requestState: row.request_state as RunRecoveryRun['requestState'],
    requestOpBoundary: row.request_op_boundary,
    requestOptions: parseJson<RecoveryRequestOptions>(row.request_options),
    completion: parseJson<RecoveryCompletion>(row.completion),
    prompt: row.prompt,
    messages: row.messages !== null ? decodeApiRecoveryMessages(row.messages) : null,
    toolNames: parseJson<string[]>(row.tool_names),
    completedThroughOpSeq: row.completed_through_op_seq,
    nextOpSeq: row.next_op_seq,
    ownerInstance: row.owner_instance,
    ownerEpoch: row.owner_epoch,
    ownerExpiresAt: row.owner_expires_at,
    finalizedAt: row.finalized_at,
    executionInput: decodeExecutionInput(row),
    instructions: row.instructions,
    executionState: parseJson(row.execution_state),
    tools: tools.map((tool) => ({
      requestIndex: tool.request_index,
      ...(tool.args === null ? {} : { args: parseJson<Record<string, unknown>>(tool.args) ?? {} }),
      opSeq: tool.op_seq,
      toolCallId: tool.tool_call_id,
      name: tool.name,
      argsDigest: tool.args_digest,
      state: tool.state as RunToolState,
      ...(tool.claim_id === null ? {} : { claimId: tool.claim_id }),
      ...(tool.success === null ? {} : { success: tool.success === 1 }),
      ...((tool.model_result ?? tool.result) === null ? {} : { result: parseJson<unknown>(tool.model_result ?? tool.result) }),
      ...(tool.error === null ? {} : { error: tool.error }),
    })),
  };
}
