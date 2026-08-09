import type {
  ExternalRecordedInvocation,
  ExternalSessionRunLedger,
} from '../../src/agent/external-run-ledger.ts';

export async function captureCheckpointedToolOutcome(
  run: ExternalSessionRunLedger,
  invocation: ExternalRecordedInvocation,
  result: unknown,
): Promise<unknown> {
  try {
    return await run.captureToolOutcome(invocation, { kind: 'success' }, result);
  } catch {
    return {
      status: 'checkpointed',
      operationId: invocation.operationId,
      warning: 'The action is durably checkpointed. Its result archive failed; do not retry this operation.',
    };
  }
}
