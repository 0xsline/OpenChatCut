import {
  isValidAgentApproval,
  isValidAgentArtifactIndex,
  isValidAgentArtifactRecord,
  isValidAgentCheckpoint,
  isValidAgentRun,
} from './agentRuntimeCodec';
import { MAX_APPROVALS } from './agentRuntimeRetention';
import {
  MAX_ARTIFACT_BYTES,
  MAX_PROJECT_ARTIFACT_BYTES,
  MAX_PROJECT_ARTIFACTS,
  type AgentRuntimeSnapshot,
} from './agentRuntimeTypes';

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function isValidAgentRuntimeSnapshot(
  snapshot: AgentRuntimeSnapshot,
): Promise<boolean> {
  const { sidecar, artifacts } = snapshot;
  if (sidecar.version !== 1 || !sidecar.projectId || artifacts.length !== sidecar.artifacts.length
    || artifacts.length > MAX_PROJECT_ARTIFACTS
    || sidecar.runs.some((run) => !isValidAgentRun(run, sidecar.projectId))
    || sidecar.approvals.some((row) => !isValidAgentApproval(row, sidecar.projectId))
    || sidecar.checkpoints.some((row) => !isValidAgentCheckpoint(row, sidecar.projectId))
    || sidecar.artifacts.some((row) => !isValidAgentArtifactIndex(row, sidecar.projectId))) return false;
  const pending = sidecar.approvals.filter((row) => row.status === 'pending');
  const pendingKeys = new Set(pending.map((row) =>
    [row.runId, row.toolName, row.argsDigest, row.operationId ?? ''].join('\u0000')));
  if (pending.length > MAX_APPROVALS || pendingKeys.size !== pending.length) return false;
  const index = new Map(sidecar.artifacts.map((row) => [row.artifactId, row]));
  let bytes = 0;
  for (const artifact of artifacts) {
    if (!isValidAgentArtifactRecord(artifact, sidecar.projectId, artifact.artifactId)
      || index.get(artifact.artifactId)?.bodySha256 !== artifact.bodySha256
      || index.get(artifact.artifactId)?.originalBytes !== artifact.originalBytes
      || artifact.originalBytes > MAX_ARTIFACT_BYTES
      || new TextEncoder().encode(artifact.body).byteLength !== artifact.originalBytes
      || await sha256Text(artifact.body) !== artifact.bodySha256) return false;
    bytes += artifact.originalBytes;
  }
  return index.size === artifacts.length && bytes <= MAX_PROJECT_ARTIFACT_BYTES;
}
