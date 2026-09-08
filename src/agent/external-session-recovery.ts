import type { ExternalEditSession } from './external-edit-session';
import { ExternalEditSessionOutcomeError } from './external-edit-session';
import {
  EXTERNAL_ACTIVE_STATUSES,
  externalSessionId,
} from './external-bridge-session';

interface RecoveryDependencies {
  projectId: string;
  sessions: Map<string, ExternalEditSession>;
  currentRevision: () => string;
  info: (session: ExternalEditSession) => unknown;
  requireSession: (sessionId: string) => ExternalEditSession;
  discard: (session: ExternalEditSession) => Promise<unknown>;
  markStale: (session: ExternalEditSession) => Promise<void>;
}

export async function executeExternalSessionRecovery(
  name: 'list_edit_sessions' | 'recover_edit_session',
  rawArgs: Record<string, unknown>,
  args: Record<string, unknown>,
  binding: { projectId: string },
  dependencies: RecoveryDependencies,
): Promise<unknown> {
  if (binding.projectId !== dependencies.projectId) {
    throw new ExternalEditSessionOutcomeError(
      'stale',
      'The editor call belongs to a different project.',
    );
  }
  if (name === 'list_edit_sessions') {
    return [...dependencies.sessions.values()].map(dependencies.info);
  }
  const session = dependencies.requireSession(externalSessionId(rawArgs));
  if (!EXTERNAL_ACTIVE_STATUSES.has(session.status)) return dependencies.info(session);
  if (args.action === 'discard') return dependencies.discard(session);
  if (args.action !== 'resume') {
    throw new ExternalEditSessionOutcomeError('rejected', 'action must be "resume" or "discard".');
  }
  if (session.baseRevision !== dependencies.currentRevision()) {
    await dependencies.markStale(session);
    throw new ExternalEditSessionOutcomeError(
      'stale',
      `Edit session ${session.id} cannot be resumed because the project revision changed.`,
    );
  }
  return dependencies.info(session);
}

export async function discardOrphanedExternalSessions(
  sessionIds: readonly string[],
  sessions: Map<string, ExternalEditSession>,
  discard: (session: ExternalEditSession) => Promise<unknown>,
): Promise<void> {
  for (const sessionId of sessionIds) {
    const session = sessions.get(sessionId);
    if (!session || !EXTERNAL_ACTIVE_STATUSES.has(session.status)) continue;
    try {
      await discard(session);
    } catch {
      // Best-effort: a disconnected transport must not wedge begin_edit_session.
    }
  }
}
