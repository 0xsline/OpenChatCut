import {
  classifyAgentRuntimeStoreValue,
  isProjectStoreRecord,
} from '../../shared/project-store-validation';
import type {
  AgentApprovalRecord,
  AgentArtifactIndexEntry,
  AgentArtifactRecord,
  AgentCheckpointRecord,
  AgentRunEvent,
  AgentRunRecord,
  AgentRuntimeSidecar,
} from './agentRuntimeStore';

const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const RUN_STATUSES: Record<string, true> = {
  running: true,
  waiting_approval: true,
  awaiting_user: true,
  completed: true,
  failed: true,
  aborted: true,
  interrupted: true,
};
const APPROVAL_STATUSES: Record<string, true> = {
  pending: true,
  allowed: true,
  denied: true,
  expired: true,
  cancelled: true,
};

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function emptySidecar(projectId: string): AgentRuntimeSidecar {
  return {
    version: 1,
    revision: 0,
    projectId,
    durability: 'local-sidecar',
    updatedAt: Date.now(),
    runs: [],
    approvals: [],
    checkpoints: [],
    artifacts: [],
  };
}

export function normalizeAgentRuntimeSidecar(
  projectId: string,
  value: unknown,
): AgentRuntimeSidecar {
  const compatibility = classifyAgentRuntimeStoreValue(`agent-runtime:${projectId}`, value);
  if (compatibility.kind === 'absent') return emptySidecar(projectId);
  if (compatibility.kind === 'future') {
    throw new Error(`Agent runtime version ${compatibility.version} is not supported.`);
  }
  if (compatibility.kind === 'corrupt') throw new Error('Agent runtime sidecar is corrupt.');
  const supported = compatibility.value;
  const runs = supported.runs.filter((item) => isValidAgentRun(item, projectId));
  const approvals = supported.approvals.filter((item) => isValidAgentApproval(item, projectId));
  const checkpoints = supported.checkpoints.filter((item) => isValidAgentCheckpoint(item, projectId));
  const artifacts = supported.artifacts.filter((item) => isValidAgentArtifactIndex(item, projectId));
  if (runs.length !== supported.runs.length || approvals.length !== supported.approvals.length
      || checkpoints.length !== supported.checkpoints.length || artifacts.length !== supported.artifacts.length) {
    throw new Error('Agent runtime sidecar contains corrupt rows.');
  }
  return {
    version: 1,
    revision: finite(supported.revision),
    projectId,
    durability: 'local-sidecar',
    updatedAt: finite(supported.updatedAt),
    lastWriterId: typeof supported.lastWriterId === 'string' ? supported.lastWriterId : undefined,
    sessionGeneration: typeof supported.sessionGeneration === 'string'
      ? supported.sessionGeneration
      : undefined,
    runs,
    approvals,
    checkpoints,
    artifacts,
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidEvent(value: unknown, projectId: string, runId: string): value is AgentRunEvent {
  return isProjectStoreRecord(value) && typeof value.eventId === 'string'
    && value.projectId === projectId && value.runId === runId
    && Number.isInteger(value.sequence) && finite(value.sequence) > 0
    && typeof value.type === 'string' && finite(value.createdAt) >= 0;
}

export function isValidAgentRun(value: unknown, projectId: string): value is AgentRunRecord {
  if (!isProjectStoreRecord(value) || value.version !== 1 || typeof value.runId !== 'string'
      || value.projectId !== projectId || RUN_STATUSES[String(value.status)] !== true
      || typeof value.askOnly !== 'boolean' || typeof value.userInputPreview !== 'string'
      || typeof value.userInputDigest !== 'string' || !SHA256.test(value.userInputDigest)
      || finite(value.createdAt) < 0 || finite(value.updatedAt) < 0) return false;
  const hasOwner = typeof value.ownerInstanceId === 'string' && value.ownerInstanceId.length > 0;
  const hasLease = finite(value.leaseExpiresAt) > 0;
  const hasToken = typeof value.leaseToken === 'string' && value.leaseToken.length > 0;
  if (hasOwner !== hasLease || (value.leaseToken !== undefined && !hasToken) || (hasToken && !hasOwner)) {
    return false;
  }
  if (value.externalSessionId !== undefined && typeof value.externalSessionId !== 'string') return false;
  return Array.isArray(value.events)
    && value.events.every((event) => isValidEvent(event, projectId, value.runId as string))
    && stringArray(value.artifactIds)
    && stringArray(value.checkpointIds)
    && stringArray(value.proposalIds);
}

export function isValidAgentApproval(
  value: unknown,
  projectId: string,
): value is AgentApprovalRecord {
  return isProjectStoreRecord(value) && value.version === 1 && value.projectId === projectId
    && typeof value.approvalId === 'string' && typeof value.runId === 'string'
    && typeof value.toolCallId === 'string' && typeof value.toolName === 'string'
    && typeof value.argsDigest === 'string' && SHA256.test(value.argsDigest)
    && APPROVAL_STATUSES[String(value.status)] === true && finite(value.createdAt) >= 0;
}

export function isValidAgentCheckpoint(
  value: unknown,
  projectId: string,
): value is AgentCheckpointRecord {
  return isProjectStoreRecord(value) && value.version === 1 && value.projectId === projectId
    && typeof value.checkpointId === 'string' && typeof value.runId === 'string'
    && typeof value.summary === 'string' && typeof value.sourceArtifactId === 'string'
    && typeof value.sourceDigest === 'string' && SHA256.test(value.sourceDigest)
    && Number.isInteger(value.sourceMessageCount) && finite(value.createdAt) >= 0;
}

export function isValidAgentArtifactIndex(
  value: unknown,
  projectId: string,
): value is AgentArtifactIndexEntry {
  return isProjectStoreRecord(value) && value.projectId === projectId
    && typeof value.artifactId === 'string' && ARTIFACT_ID.test(value.artifactId)
    && typeof value.runId === 'string'
    && (value.kind === 'tool-result'
      || value.kind === 'checkpoint-source'
      || value.kind === 'server-run-draft')
    && typeof value.bodySha256 === 'string' && SHA256.test(value.bodySha256)
    && Number.isInteger(value.originalBytes) && finite(value.originalBytes) >= 0
    && Number.isInteger(value.originalChars) && finite(value.originalChars) >= 0
    && finite(value.createdAt) >= 0
    && typeof value.redacted === 'boolean' && typeof value.binaryOmitted === 'boolean';
}

export function isValidAgentArtifactRecord(
  value: unknown,
  projectId: string,
  artifactId: string,
): value is AgentArtifactRecord {
  return isProjectStoreRecord(value) && value.version === 1 && value.artifactId === artifactId
    && typeof value.body === 'string' && isValidAgentArtifactIndex(value, projectId);
}
