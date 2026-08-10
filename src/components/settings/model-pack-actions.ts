import type { ModelPackId } from '../../../shared/model-packs';

export type ModelPackMutation = (id: ModelPackId, headers: HeadersInit) => Promise<unknown>;

export async function executeModelPackMutation(
  id: ModelPackId,
  action: ModelPackMutation,
): Promise<unknown> {
  return action(id, {});
}
