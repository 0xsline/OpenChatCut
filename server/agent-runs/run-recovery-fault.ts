/**
 * Faults raised by the Agent recovery boundary.
 *
 * These are deliberately not ordinary tool failures. A tool failure is a
 * business answer the model is allowed to see and react to; a recovery fault
 * means the runtime can no longer prove what happened, so the turn must stop
 * before anything else is dispatched and the run must stay open for
 * reconciliation. Three consumers have to honour that:
 *
 *  - the subprocess bridge, which otherwise reports the throw as a normal tool
 *    error and lets the model continue;
 *  - the outer turn retry, which would otherwise replay the prompt;
 *  - the executor's failure settlement, which would otherwise write
 *    `failed` + `done` and close a run whose writes are still unresolved.
 */
export type RunRecoveryFaultCode =
  | 'recovery-write-failed'
  | 'ownership-lost'
  | 'outcome-unknown';

export class RunRecoveryFault extends Error {
  readonly code: RunRecoveryFaultCode;
  readonly freezesRun = true;

  constructor(code: RunRecoveryFaultCode, message: string) {
    super(message);
    this.name = 'RunRecoveryFault';
    this.code = code;
  }
}

export function isRunRecoveryFault(error: unknown): error is RunRecoveryFault {
  return error instanceof RunRecoveryFault
    || (typeof error === 'object'
      && error !== null
      && Reflect.get(error, 'freezesRun') === true
      && typeof Reflect.get(error, 'code') === 'string');
}

/** Wraps any thrown error from the recovery store so it cannot be mistaken for a tool answer. */
export function asRecoveryFault(
  error: unknown,
  code: RunRecoveryFaultCode = 'recovery-write-failed',
): RunRecoveryFault {
  if (isRunRecoveryFault(error)) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new RunRecoveryFault(code, `Agent run recovery could not be persisted: ${reason}`);
}
