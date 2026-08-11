import type { SlipFailure } from '../../editor/slip';

export type OpResult = Record<string, unknown>;

export function slipFailureToOpResult(failure: SlipFailure): OpResult {
  return {
    ok: false,
    code: failure.code,
    itemId: failure.itemId,
    error: failure.error,
  };
}
