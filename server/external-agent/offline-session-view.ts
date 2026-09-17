// Projections for an offline edit session: the AgentContext its tools run against,
// the status payload the MCP/CLI surface returns, and the message shown when a
// tool's result was archived instead of returned inline.
//
// Split out of offline-runtime.ts, which is at the file-size ceiling.
import type { AgentContext } from '../../src/agent/context.ts';
import type { ExternalEditSession } from '../../src/agent/external-edit-session.ts';
import { OFFLINE_AUDIO, type OfflineEditorCatalogs } from './offline-catalogs.ts';

/** Draft commands/state/doc plus the catalogs every headless host shares. */
export function offlineAgentContext(
  draft: NonNullable<ExternalEditSession['draft']>,
  projectId: string,
  catalogs: OfflineEditorCatalogs,
): AgentContext {
  return {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: catalogs.templates,
    audio: OFFLINE_AUDIO,
    getProjectId: () => projectId,
    getApprovalMode: () => 'auto',
  };
}

export function offlineSessionInfo(
  session: ExternalEditSession,
  editorUrl: string,
  agentRunId: string | undefined,
): Record<string, unknown> {
  return {
    editSessionId: session.id,
    status: session.status,
    clientName: session.clientName,
    approvalMode: session.approvalMode,
    baseRevision: session.baseRevision,
    operationCount: session.operationCount,
    appliedOperationCount: session.appliedOperationCount,
    bindingMode: 'offline',
    ...(agentRunId ? { agentRunId } : {}),
    editorUrl,
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

/** A tool failure the runtime archived instead of returning inline. */
export function projectedFailureMessage(projected: unknown): string {
  if (projected && typeof projected === 'object' && !Array.isArray(projected)) {
    if ('error' in projected && typeof projected.error === 'string') {
      return projected.error.slice(0, 1_200);
    }
    if ('artifactId' in projected && typeof projected.artifactId === 'string') {
      return `The tool returned an archived error result. Read artifact ${projected.artifactId} for details.`;
    }
  }
  return 'The tool returned an error result.';
}
