import type { ServerRunProjectWrite } from './serverRunProtocol';
import type { AgentTurn } from './useAgentRun';

/** Operations waiting to land on the live project during the run rather than in the proposal. */
export interface LandableOperations {
  readonly persistent: number;
  readonly live: number;
}

export function landableOperations(
  turn: Pick<AgentTurn, 'persistentOps' | 'ops' | 'liveEdits'>,
): LandableOperations {
  return { persistent: turn.persistentOps.length, live: turn.liveEdits ? turn.ops.length : 0 };
}

/**
 * Landing saves before it applies and keeps a failed batch queued on the turn, so a
 * batch this call added to that is still non-empty after landing holds its own edits.
 */
export function projectWriteOutcome(
  before: LandableOperations,
  added: LandableOperations,
  after: LandableOperations,
): ServerRunProjectWrite {
  const addsPersistent = added.persistent > before.persistent;
  const addsLive = added.live > before.live;
  if (!addsPersistent && !addsLive) return 'none';
  return (addsPersistent && after.persistent > 0) || (addsLive && after.live > 0)
    ? 'queued'
    : 'saved';
}

export const PROJECT_SAVE_WARNING = 'This call succeeded and its edit is recorded, but the project could not '
  + 'be saved, so the edit is queued until a later save succeeds. Do not repeat this call: the edit '
  + 'would be applied twice. Stop making further edits and tell the user to check project storage.';

/**
 * The call stays successful: a failure would invite a retry, and the queued edit
 * lands on the next successful save, so a repeated call would duplicate it.
 */
export function withProjectSaveWarning(result: unknown): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...result, projectSaveWarning: PROJECT_SAVE_WARNING };
  }
  return { result: result ?? null, projectSaveWarning: PROJECT_SAVE_WARNING };
}
