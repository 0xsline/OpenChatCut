import { SERVER_RUN_CAPABILITY_HEADER } from './serverRunProtocol';
import { permanentServerRunRecoveryError } from './serverRunRecovery';
import { projectServerRunToolResult } from './serverRunToolResult';
import { permanentToolHttpStatus, type ToolClaimResponse } from './serverRunToolTransport';
import type { RecoveredServerTool } from './serverRunToolRecovery';

export interface ServerRunToolSession {
  readonly runId: string;
  readonly capability: string;
  readonly claimId: string | null;
  readonly abort: AbortController;
}

export async function claimServerRunTool(
  projectId: string,
  session: ServerRunToolSession,
  toolCallId: string,
  argsDigest: string,
  abandonRecovery: (runId: string, error: unknown) => void,
): Promise<ToolClaimResponse | null> {
  if (!session.claimId) return null;
  const response = await fetch(`/api/agent-runs/${session.runId}/tool-claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SERVER_RUN_CAPABILITY_HEADER]: session.capability,
    },
    body: JSON.stringify({ projectId, toolCallId, argsDigest, claimId: session.claimId }),
    signal: session.abort.signal,
  }).catch(() => null);
  if (response && (response.status === 403
    || response.status === 404
    || response.status === 410)) {
    abandonRecovery(
      session.runId,
      permanentServerRunRecoveryError(
        `Server tool claim is permanently unavailable: HTTP ${response.status}`,
      ),
    );
    return { claimed: false, outcome: 'run-stale' };
  }
  if (!response || (response.status !== 200 && response.status !== 409)) return null;
  return response.json().catch(() => null) as Promise<ToolClaimResponse | null>;
}

export async function postServerRunToolResult(
  projectId: string,
  session: ServerRunToolSession,
  toolCallId: string,
  outcome: RecoveredServerTool,
  abandonRecovery: (runId: string, error: unknown) => void,
): Promise<boolean> {
  if (!session.claimId) return false;
  const body = outcome.error === undefined
    ? {
      projectId, toolCallId, argsDigest: outcome.argsDigest, claimId: session.claimId,
      result: projectServerRunToolResult(outcome.result),
    }
    : {
      projectId, toolCallId, argsDigest: outcome.argsDigest, claimId: session.claimId,
      error: outcome.error,
    };
  const response = await fetch(`/api/agent-runs/${session.runId}/tool-result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SERVER_RUN_CAPABILITY_HEADER]: session.capability,
    },
    body: JSON.stringify(body),
    signal: session.abort.signal,
  }).catch(() => null);
  if (response && permanentToolHttpStatus(response.status)) {
    abandonRecovery(
      session.runId,
      permanentServerRunRecoveryError(
        `Server tool result is permanently unavailable: HTTP ${response.status}`,
      ),
    );
    return true;
  }
  return response?.ok === true;
}
