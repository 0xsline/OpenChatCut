import { parseAgentSessionGenerationRecord } from './agent-session-generation.ts';
import type { ProjectStoreRequest } from './project-store-transport.ts';

const VALID_KEY = /^(?!__proto__$)(?!prototype$)(?!constructor$)[a-zA-Z0-9:_-]{1,300}$/;const VALID_AGENT_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const SEMANTIC_EMBEDDING_DIMENSION = 512;
const VALID_AGENT_ARTIFACT_ID = /^[a-zA-Z0-9_-]{1,20}$/;
const VALID_SESSION_GENERATION = /^[a-zA-Z0-9_-]{1,80}$/;
const VALID_UPLOAD_FINALIZE_HASH = /^[a-f0-9]{64}$/;
const STRICT_PROJECT_SCOPED_KEY = /^(?:agent-runtime|agent-session-generation|external-proposal|offline-edit-session|project-edit-ownership|review):([a-zA-Z0-9_-]{1,160})$/;
const STRICT_PROJECT_SCOPED_PREFIX = /^(?:agent-runtime|agent-artifact|agent-session-generation|agent-session-chat|agent-session-proposal|agent-session-runtime|agent-session-artifact|external-proposal|offline-edit-session|project-edit-ownership|review|upload-finalize):/;
const LEGACY_PROJECT_SCOPED_KEY = /^(?:project|chat|creative-mode|thumb|proposal|versions|jobs):(.+)$/;

function sessionProjectId(key: string, namespace: string, trailingParts: number): string | undefined {
  if (!key.startsWith(`${namespace}:`)) return undefined;
  const parts = key.slice(namespace.length + 1).split(':');
  return parts.length === trailingParts + 2
    && VALID_AGENT_PROJECT_ID.test(parts[0]!)
    && VALID_SESSION_GENERATION.test(parts[1]!)
    ? parts[0]
    : undefined;
}

function uploadFinalizeProjectId(key: string): string | undefined {
  if (!key.startsWith('upload-finalize:')) return undefined;
  const parts = key.slice('upload-finalize:'.length).split(':');
  return parts.length === 2
    && VALID_AGENT_PROJECT_ID.test(parts[0]!)
    && VALID_UPLOAD_FINALIZE_HASH.test(parts[1]!)
    ? parts[0]
    : undefined;
}

/** Return the owning project without treating generation or artifact ids as part of it. */
export function projectIdFromProjectStoreKey(key: string): string | undefined {
  const strictProjectId = STRICT_PROJECT_SCOPED_KEY.exec(key)?.[1];
  if (strictProjectId) return strictProjectId;
  if (key.startsWith('agent-artifact:')) {
    const parts = key.slice('agent-artifact:'.length).split(':');
    return parts.length === 2
      && VALID_AGENT_PROJECT_ID.test(parts[0]!)
      && VALID_AGENT_ARTIFACT_ID.test(parts[1]!)
      ? parts[0]
      : undefined;
  }
  const sessionArtifactProject = sessionProjectId(key, 'agent-session-artifact', 1);
  if (sessionArtifactProject) {
    const artifactId = key.split(':').at(-1);
    return artifactId && VALID_AGENT_ARTIFACT_ID.test(artifactId)
      ? sessionArtifactProject
      : undefined;
  }
  const uploadFinalizeProject = uploadFinalizeProjectId(key);
  if (uploadFinalizeProject) return uploadFinalizeProject;
  return sessionProjectId(key, 'agent-session-chat', 0)
    ?? sessionProjectId(key, 'agent-session-proposal', 0)
    ?? sessionProjectId(key, 'agent-session-runtime', 0)
    ?? LEGACY_PROJECT_SCOPED_KEY.exec(key)?.[1];
}

function isAgentRuntimeKey(key: string): boolean {
  return key.startsWith('agent-runtime:') || key.startsWith('agent-session-runtime:');
}

function agentArtifactKeyParts(key: string): [string, string] | null {
  const legacy = key.startsWith('agent-artifact:')
    ? key.slice('agent-artifact:'.length).split(':')
    : [];
  if (legacy.length === 2) return [legacy[0]!, legacy[1]!];
  const scoped = key.startsWith('agent-session-artifact:')
    ? key.slice('agent-session-artifact:'.length).split(':')
    : [];
  return scoped.length === 3 ? [scoped[0]!, scoped[2]!] : null;
}

const MAX_ENTRY_COUNT = 20_000;
export function isAgentSessionGenerationStoreValue(key: string, value: unknown): boolean {
  return key.startsWith('agent-session-generation:')
    && projectIdFromProjectStoreKey(key) !== undefined
    && parseAgentSessionGenerationRecord(value) !== null;
}

export const isProjectStoreRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export interface SupportedAgentRuntimeStoreValue extends Record<string, unknown> {
  version: 1;
  revision: number;
  projectId: string;
  durability: 'local-sidecar';
  updatedAt: number;
  lastWriterId?: string;
  sessionGeneration?: string;
  runs: unknown[];
  approvals: unknown[];
  checkpoints: unknown[];
  artifacts: unknown[];
}

export type AgentRuntimeStoreCompatibility =
  | { kind: 'absent' }
  | { kind: 'supported'; value: SupportedAgentRuntimeStoreValue }
  | { kind: 'future'; version: number; value: Record<string, unknown> }
  | { kind: 'corrupt'; value: unknown };
function hasScopedAgentRuntimeRows(key: string, value: Record<string, unknown>): boolean {
  const projectId = projectIdFromProjectStoreKey(key);
  if (!projectId) return false;
  const groups: Array<[unknown, string]> = [
    [value.runs, 'runId'],
    [value.approvals, 'approvalId'],
    [value.checkpoints, 'checkpointId'],
    [value.artifacts, 'artifactId'],
  ];
  return groups.every(([rows, id]) => Array.isArray(rows) && rows.every((row) => (
    isProjectStoreRecord(row)
    && row.projectId === projectId
    && typeof row[id] === 'string'
    && row[id].length > 0
  )));
}
function isSupportedAgentRuntimeStoreValue(
  key: string,
  value: unknown,
): value is SupportedAgentRuntimeStoreValue {
  const projectId = projectIdFromProjectStoreKey(key);
  return isProjectStoreRecord(value)
    && isAgentRuntimeKey(key)
    && value.version === 1
    && projectId !== undefined
    && value.projectId === projectId
    && value.durability === 'local-sidecar'
    && typeof value.revision === 'number'
    && Number.isFinite(value.revision)
    && value.revision >= 0
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && value.updatedAt >= 0
    && (value.lastWriterId === undefined || typeof value.lastWriterId === 'string')
    && (value.sessionGeneration === undefined || (
      typeof value.sessionGeneration === 'string'
      && /^[A-Za-z0-9_-]{1,80}$/.test(value.sessionGeneration)
    ))
    && Array.isArray(value.runs)
    && Array.isArray(value.approvals)
    && Array.isArray(value.checkpoints)
    && Array.isArray(value.artifacts)
    && hasScopedAgentRuntimeRows(key, value);
}



export function classifyAgentRuntimeStoreValue(
  key: string,
  value: unknown,
): AgentRuntimeStoreCompatibility {
  const projectId = projectIdFromProjectStoreKey(key);
  if (value === undefined) return { kind: 'absent' };
  if (
    isProjectStoreRecord(value)
    && isAgentRuntimeKey(key)
    && projectId !== undefined
    && value.projectId === projectId
    && typeof value.version === 'number'
    && Number.isSafeInteger(value.version)
    && value.version > 1
  ) {
    return { kind: 'future', version: value.version, value };
  }
  if (isSupportedAgentRuntimeStoreValue(key, value)) {
    return { kind: 'supported', value };
  }
  return { kind: 'corrupt', value };
}


export function isAgentRuntimeStoreValue(
  key: string,
  value: unknown,
): value is SupportedAgentRuntimeStoreValue {
  return classifyAgentRuntimeStoreValue(key, value).kind === 'supported';
}

export function isAgentArtifactStoreValue(key: string, value: unknown): value is Record<string, unknown> {
  const parts = agentArtifactKeyParts(key);
  return isProjectStoreRecord(value)
    && parts !== null
    && projectIdFromProjectStoreKey(key) === parts[0]
    && value.version === 1
    && value.projectId === parts[0]
    && value.artifactId === parts[1]
    && typeof value.runId === 'string'
    && value.runId.length > 0
    && typeof value.kind === 'string'
    && value.kind.length > 0
    && typeof value.bodySha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.bodySha256)
    && typeof value.originalBytes === 'number'
    && Number.isSafeInteger(value.originalBytes)
    && value.originalBytes >= 0
    && typeof value.originalChars === 'number'
    && Number.isSafeInteger(value.originalChars)
    && value.originalChars >= 0
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && value.createdAt >= 0
    && typeof value.redacted === 'boolean'
    && typeof value.binaryOmitted === 'boolean'
    && typeof value.body === 'string'
    && (value.toolCallId === undefined || typeof value.toolCallId === 'string')
    && (value.toolName === undefined || typeof value.toolName === 'string');
}

export function isProjectStoreKey(value: unknown): value is string {
  if (typeof value !== 'string' || !VALID_KEY.test(value)) return false;
  if (STRICT_PROJECT_SCOPED_PREFIX.test(value)) {
    return projectIdFromProjectStoreKey(value) !== undefined;
  }
  return true;
}

export function isProjectStoreEntries(value: unknown): value is Record<string, unknown> {
  return isProjectStoreRecord(value)
    && Object.keys(value).length <= MAX_ENTRY_COUNT
    && Object.keys(value).every(isProjectStoreKey);
}

const PROJECT_DOCUMENT_CAS_KEY = /^project:[a-zA-Z0-9_-]{1,160}$/;
const AGENT_RUN_LEASE_KEYS: Record<string, true> = {
  operation: true,
  key: true,
  runId: true,
  action: true,
  ownerInstanceId: true,
  leaseToken: true,
  leaseMs: true,
};
const EXPORT_RECOVERY_LEASE_KEYS: Record<string, true> = {
  operation: true,
  key: true,
  renderId: true,
  action: true,
  ownerInstanceId: true,
  leaseToken: true,
  leaseMs: true,
  value: true,
  authorityEstablished: true,
};

function isAgentRuntimeCasRequest(value: Record<string, unknown>): boolean {
  const expectedRevision = value.expectedRevision;
  const validRevision = expectedRevision === null
    || (typeof expectedRevision === 'number'
      && Number.isSafeInteger(expectedRevision)
      && expectedRevision >= 0);
  return Object.keys(value).length === 4
    && isProjectStoreKey(value.key)
    && isAgentRuntimeKey(value.key)
    && validRevision
    && isAgentRuntimeStoreValue(value.key, value.value);
}

function isProjectDocumentCasRequest(value: Record<string, unknown>): boolean {
  if (typeof value.key !== 'string'
    || !PROJECT_DOCUMENT_CAS_KEY.test(value.key)
    || !Object.hasOwn(value, 'value')) return false;
  if (value.expectedRevision === null) return Object.keys(value).length === 4;
  return Object.keys(value).length === 6
    && typeof value.expectedRevision === 'string'
    && value.expectedRevision.length > 0
    && value.expectedRevision.length <= 200
    && typeof value.ownerId === 'string'
    && /^[a-zA-Z0-9_-]{1,200}$/.test(value.ownerId)
    && typeof value.ownershipEpoch === 'number'
    && Number.isSafeInteger(value.ownershipEpoch)
    && value.ownershipEpoch >= 1;
}

function isAgentRunLeaseRequest(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const validLeaseToken = value.leaseToken === undefined
    || (typeof value.leaseToken === 'string'
      && value.leaseToken.length > 0
      && value.leaseToken.length <= 200);
  const validLeaseMs = value.leaseMs === undefined
    || (typeof value.leaseMs === 'number'
      && Number.isSafeInteger(value.leaseMs)
      && value.leaseMs >= 1_000
      && value.leaseMs <= 300_000);
  return keys.length >= 5
    && keys.length <= 7
    && keys.every((key) => Object.hasOwn(AGENT_RUN_LEASE_KEYS, key))
    && isProjectStoreKey(value.key)
    && isAgentRuntimeKey(value.key)
    && typeof value.runId === 'string'
    && value.runId.length > 0
    && value.runId.length <= 200
    && (
      value.action === 'claim'
      || value.action === 'renew'
      || value.action === 'release'
      || value.action === 'check'
    )
    && typeof value.ownerInstanceId === 'string'
    && value.ownerInstanceId.length > 0
    && value.ownerInstanceId.length <= 200
    && validLeaseToken
    && validLeaseMs;
}
function isExportRecoveryLeaseRequest(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  const renderId = typeof value.renderId === 'string' ? value.renderId : '';
  const validToken = value.leaseToken === undefined
    || (typeof value.leaseToken === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value.leaseToken));
  const validDuration = value.leaseMs === undefined
    || (typeof value.leaseMs === 'number' && Number.isSafeInteger(value.leaseMs)
      && value.leaseMs >= 1_000 && value.leaseMs <= 300_000);
  return keys.length >= 5 && keys.length <= 9
    && keys.every((key) => Object.hasOwn(EXPORT_RECOVERY_LEASE_KEYS, key))
    && /^[a-zA-Z0-9_-]{1,200}$/.test(renderId)
    && value.key === `export-recovery:${renderId}`
    && (value.action === 'claim' || value.action === 'renew'
      || value.action === 'release' || value.action === 'check' || value.action === 'retire'
      || value.action === 'ready' || value.action === 'ambiguous'
      || value.action === 'commit' || value.action === 'rebind'
      || value.action === 'reconcile')
    && typeof value.ownerInstanceId === 'string'
    && /^[a-zA-Z0-9_-]{1,200}$/.test(value.ownerInstanceId)
    && validToken && validDuration
    && (value.action !== 'rebind'
      || (Object.hasOwn(value, 'value') && isProjectStoreRecord(value.value)))
    && (value.action !== 'reconcile'
      || (Object.hasOwn(value, 'value') && isProjectStoreRecord(value.value)
        && typeof value.authorityEstablished === 'boolean'));
}

export function isProjectStoreRequest(value: unknown): value is ProjectStoreRequest {
  if (!isProjectStoreRecord(value) || typeof value.operation !== 'string') return false;
  if (value.operation === 'snapshot') return Object.keys(value).length === 1;
  if (value.operation === 'entry') {
    return Object.keys(value).length === 2 && isProjectStoreKey(value.key);
  }
  if (value.operation === 'delete') {
    return Object.keys(value).length === 2
      && isProjectStoreKey(value.key)
      && !value.key.startsWith('agent-session-generation:')
      && !value.key.startsWith('export-recovery:');
  }
  if (value.operation === 'purge-project' || value.operation === 'agent-session-rotate') {
    return Object.keys(value).length === 2
      && typeof value.projectId === 'string'
      && VALID_AGENT_PROJECT_ID.test(value.projectId);
  }
  if (value.operation === 'merge') {
    return Object.keys(value).length === 2
      && isProjectStoreEntries(value.entries)
      && !Object.keys(value.entries).some((key) => key.startsWith('export-recovery:'));
  }
  if (value.operation === 'set') {
    return Object.keys(value).length === 3
      && isProjectStoreKey(value.key)
      && !value.key.startsWith('agent-session-generation:')
      && !value.key.startsWith('export-recovery:')
      && Object.hasOwn(value, 'value');
  }
  if (value.operation === 'agent-runtime-cas') return isAgentRuntimeCasRequest(value);
  if (value.operation === 'project-document-cas') return isProjectDocumentCasRequest(value);
  if (value.operation === 'agent-run-lease') return isAgentRunLeaseRequest(value);
  if (value.operation === 'export-recovery-lease') return isExportRecoveryLeaseRequest(value);
  if (value.operation === 'semantic-vectors-upsert') {
    return Object.keys(value).length === 3
      && typeof value.scopeId === 'string' && VALID_AGENT_PROJECT_ID.test(value.scopeId)
      && typeof value.assetId === 'string' && VALID_AGENT_PROJECT_ID.test(value.assetId)
      && Array.isArray(value.samples)
      && value.samples.length <= 512
      && value.samples.every((sample) => (
        sample !== null
        && typeof sample === 'object'
        && !Array.isArray(sample)
        && typeof (sample as { assetId?: unknown }).assetId === 'string'
        && VALID_AGENT_PROJECT_ID.test((sample as { assetId: string }).assetId)
        && typeof (sample as { sampleTime?: unknown }).sampleTime === 'number'
        && Array.isArray((sample as { vector?: unknown }).vector)
        && ((sample as { vector: unknown[] }).vector.length === SEMANTIC_EMBEDDING_DIMENSION)
      ));
  }
  if (value.operation === 'semantic-vectors-search') {
    return Object.keys(value).length === 3
      && typeof value.scopeId === 'string' && VALID_AGENT_PROJECT_ID.test(value.scopeId)
      && Array.isArray(value.queryVector)
      && value.queryVector.length === SEMANTIC_EMBEDDING_DIMENSION
      && typeof value.limit === 'number';
  }
  if (value.operation === 'semantic-vectors-prune') {
    return Object.keys(value).length >= 2
      && typeof value.scopeId === 'string' && VALID_AGENT_PROJECT_ID.test(value.scopeId)
      && Array.isArray(value.validAssetIds)
      && value.validAssetIds.every((id) => typeof id === 'string' && VALID_AGENT_PROJECT_ID.test(id))
      && (value.validSourceRevisions === undefined
        || (value.validSourceRevisions !== null
          && typeof value.validSourceRevisions === 'object'
          && !Array.isArray(value.validSourceRevisions)));
  }
  if (value.operation === 'semantic-vectors-clear') {
    return Object.keys(value).length === 2
      && typeof value.scopeId === 'string' && VALID_AGENT_PROJECT_ID.test(value.scopeId);
  }
  return false;
}
