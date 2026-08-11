import type { ModelMessage } from 'ai';
import { isProjectStoreRecord as isRecord } from '../../shared/project-store-validation';
import { verifyCanonicalContextCheckpoint } from '../agent/context-compaction';
import type { PersistedChat } from './projectStore';
import {
  MAX_AGENT_RUNS, MAX_APPROVALS, MAX_ARTIFACT_BYTES, MAX_CHECKPOINTS, MAX_EVENTS_PER_RUN,
  MAX_PROJECT_ARTIFACT_BYTES, MAX_PROJECT_ARTIFACTS, sha256Text,
  type AgentApprovalRecord, type AgentArtifactIndexEntry, type AgentArtifactRecord,
  type AgentCheckpointRecord, type AgentRunEvent, type AgentRunRecord,
  type AgentRuntimeSidecar, type AgentRuntimeSnapshot,
} from './agentRuntimeStore';

const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_RUNTIME_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_RUNS = MAX_AGENT_RUNS + MAX_APPROVALS;
const encoder = new TextEncoder();

export const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum;
const string = (value: unknown, max = 262_144): value is string =>
  typeof value === 'string' && value.length <= max;
const safeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);
const optionalString = (value: unknown, max?: number): boolean => value === undefined || string(value, max);
const optionalSha = (value: unknown): boolean => value === undefined || (typeof value === 'string' && SHA256.test(value));
const optionalInteger = (value: unknown): boolean => value === undefined || integer(value);
const optionalStringList = (value: unknown): boolean => value === undefined
  || (Array.isArray(value) && value.length <= 8 && value.every((item) => string(item, 64)));
const uniqueStrings = (value: unknown, pattern = SAFE_ID): value is string[] =>
  Array.isArray(value) && value.length === new Set(value).size
  && value.every((item) => typeof item === 'string' && pattern.test(item));
export const allowedKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function validOutcome(value: unknown): boolean {
  if (!isRecord(value) || !allowedKeys(value, ['kind', 'code', 'operationId', 'artifactId', 'summary'])) return false;
  return ['success', 'validation_failed', 'denied', 'aborted_before_side_effect', 'stale',
    'retryable_failure', 'outcome_unknown', 'terminal_failure'].includes(String(value.kind))
    && optionalString(value.code, 256) && optionalString(value.operationId, 512)
    && (value.artifactId === undefined || (typeof value.artifactId === 'string' && ARTIFACT_ID.test(value.artifactId)))
    && optionalString(value.summary);
}

function validEvent(value: unknown, projectId: string, runId: string): value is AgentRunEvent {
  if (!isRecord(value) || !allowedKeys(value, ['eventId', 'projectId', 'runId', 'sequence', 'type', 'createdAt',
    'toolCallId', 'toolName', 'operationId', 'argsDigest', 'resultDigest', 'approvalId', 'checkpointId',
    'proposalId', 'outcome', 'summary', 'context'])) return false;
  const types = ['configured', 'context_projected', 'context_usage', 'checkpoint_created',
    'tool_requested', 'tool_started', 'tool_outcome', 'approval_requested', 'approval_decided',
    'proposal_created', 'proposal_applied', 'proposal_rejected', 'proposal_stale',
    'proposal_reproposed', 'final'];
  return safeId(value.eventId) && value.projectId === projectId && value.runId === runId
    && integer(value.sequence, 1) && types.includes(String(value.type)) && integer(value.createdAt)
    && optionalString(value.toolCallId, 512) && optionalString(value.toolName, 256)
    && optionalString(value.operationId, 512) && optionalSha(value.argsDigest) && optionalSha(value.resultDigest)
    && (value.approvalId === undefined || safeId(value.approvalId))
    && (value.checkpointId === undefined || safeId(value.checkpointId))
    && (value.proposalId === undefined || safeId(value.proposalId))
    && (value.outcome === undefined || validOutcome(value.outcome))
    && validContext(value.context) && optionalString(value.summary);
}

function validContext(value: unknown): boolean {
  if (value === undefined) return true;
  const numericKeys = [
    'systemTokens', 'toolSchemaChars', 'historyTokens', 'activeToolCount',
    'toolSchemaCount', 'inputTokens', 'outputTokens', 'reasoningTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'noCacheTokens', 'cacheTtlMs',
    'requestIndex', 'attemptIndex', 'retryCount', 'mediaInputCount',
    'mediaTokenEstimate', 'modelRequestCount', 'totalInputTokens',
    'totalFreshInputTokens', 'totalCacheReadTokens', 'totalCacheWriteTokens',
    'totalOutputTokens', 'totalReasoningTokens', 'totalRetryCount',
    'totalMediaInputs', 'totalMediaTokenEstimate', 'cacheMissTokens',
    'lastRequestAt',
  ] as const;
  const keys = [
    'requestShapeHash', 'modelId', 'systemDigest', 'toolSchemaDigest',
    'checkpointId', 'retryReasons', 'cacheHitRatio', 'cacheMissReason',
    'serverRunCapabilityVerifier', 'transportStatus', 'transportError',
    ...numericKeys,
  ];
  if (!isRecord(value) || !allowedKeys(value, keys)
    || typeof value.requestShapeHash !== 'string' || !SHA256.test(value.requestShapeHash)
    || !optionalString(value.modelId, 512)
    || !optionalSha(value.systemDigest) || !optionalSha(value.toolSchemaDigest)
    || (value.checkpointId !== undefined && !safeId(value.checkpointId))
    || !optionalStringList(value.retryReasons)
    || !optionalSha(value.serverRunCapabilityVerifier)
    || (value.transportStatus !== undefined && ![
      'queued', 'running', 'awaiting-confirmation', 'awaiting-user', 'completed', 'failed', 'cancelled',
    ].includes(String(value.transportStatus)))
    || (value.transportError !== undefined && value.transportError !== null
      && !string(value.transportError, 4_096))
    || !numericKeys.every((key) => optionalInteger(value[key]))) return false;
  if (value.cacheHitRatio !== undefined && (
    typeof value.cacheHitRatio !== 'number' || !Number.isFinite(value.cacheHitRatio)
    || value.cacheHitRatio < 0 || value.cacheHitRatio > 1
  )) return false;
  return value.cacheMissReason === undefined || [
    'none', 'first_request', 'model_changed', 'system_prompt_changed',
    'tool_surface_changed', 'idle_ttl_expired', 'unknown',
  ].includes(String(value.cacheMissReason));
}

function validRun(value: unknown, projectId: string): value is AgentRunRecord {
  if (!isRecord(value) || !allowedKeys(value, ['version', 'runId', 'projectId', 'status', 'askOnly',
    'userInputPreview', 'userInputDigest', 'createdAt', 'updatedAt', 'ownerInstanceId', 'leaseToken',
    'leaseExpiresAt', 'modelId', 'backend', 'externalSessionId', 'context', 'artifactIds',
    'checkpointIds', 'proposalIds', 'events', 'finalSummary'])) return false;
  const statuses = ['running', 'waiting_approval', 'awaiting_user', 'completed', 'failed', 'aborted', 'interrupted'];
  const hasOwner = safeId(value.ownerInstanceId);
  const hasLease = integer(value.leaseExpiresAt, 1);
  const hasToken = string(value.leaseToken, 512) && value.leaseToken.length > 0;
  const externalSessionValid = value.externalSessionId === undefined
    || (string(value.externalSessionId, 512)
      && value.externalSessionId.trim().length > 0
      && value.externalSessionId === value.externalSessionId.trim());
  if (value.version !== 1 || !safeId(value.runId) || value.projectId !== projectId
    || !statuses.includes(String(value.status)) || typeof value.askOnly !== 'boolean'
    || !string(value.userInputPreview) || typeof value.userInputDigest !== 'string'
    || !SHA256.test(value.userInputDigest) || !integer(value.createdAt) || !integer(value.updatedAt)
    || !optionalString(value.modelId, 512) || !optionalString(value.backend, 128)
    || !externalSessionValid
    || !validContext(value.context) || !uniqueStrings(value.artifactIds, ARTIFACT_ID)
    || !uniqueStrings(value.checkpointIds) || !uniqueStrings(value.proposalIds)
    || !Array.isArray(value.events) || value.events.length > MAX_EVENTS_PER_RUN
    || !value.events.every((event) => validEvent(event, projectId, value.runId as string))
    || !optionalString(value.finalSummary)) return false;
  if ((value.ownerInstanceId !== undefined && !hasOwner)
      || (value.leaseExpiresAt !== undefined && !hasLease)
      || hasOwner !== hasLease || (value.leaseToken !== undefined && !hasToken)
      || (hasToken && !hasOwner)) return false;
  let sequence = 0;
  const eventIds = new Set<string>();
  for (const event of value.events as AgentRunEvent[]) {
    if (event.sequence <= sequence || eventIds.has(event.eventId)) return false;
    sequence = event.sequence;
    eventIds.add(event.eventId);
  }
  return true;
}

function validApproval(value: unknown, projectId: string): value is AgentApprovalRecord {
  if (!isRecord(value) || !allowedKeys(value, ['version', 'approvalId', 'projectId', 'runId', 'toolCallId',
    'toolName', 'argsDigest', 'operationId', 'status', 'createdAt', 'decidedAt', 'summary'])) return false;
  return value.version === 1 && safeId(value.approvalId) && value.projectId === projectId && safeId(value.runId)
    && string(value.toolCallId, 512) && string(value.toolName, 256) && typeof value.argsDigest === 'string'
    && SHA256.test(value.argsDigest) && optionalString(value.operationId, 512)
    && ['pending', 'allowed', 'denied', 'expired', 'cancelled'].includes(String(value.status))
    && integer(value.createdAt) && (value.decidedAt === undefined || integer(value.decidedAt))
    && optionalString(value.summary);
}

function validCheckpoint(value: unknown, projectId: string): value is AgentCheckpointRecord {
  if (!isRecord(value) || !allowedKeys(value, ['version', 'checkpointId', 'projectId', 'runId', 'summary',
    'summaryDigest', 'sourceMessageCount', 'sourceDigest', 'sourceArtifactId', 'createdAt'])) return false;
  return value.version === 1 && safeId(value.checkpointId) && value.projectId === projectId && safeId(value.runId)
    && string(value.summary) && optionalSha(value.summaryDigest) && integer(value.sourceMessageCount)
    && typeof value.sourceDigest === 'string' && SHA256.test(value.sourceDigest)
    && typeof value.sourceArtifactId === 'string' && ARTIFACT_ID.test(value.sourceArtifactId)
    && integer(value.createdAt);
}

export function validArtifact(value: unknown, projectId: string): value is AgentArtifactRecord {
  if (!isRecord(value) || !allowedKeys(value, ['version', 'artifactId', 'projectId', 'runId', 'kind',
    'bodySha256', 'originalBytes', 'originalChars', 'createdAt', 'redacted', 'binaryOmitted', 'body',
    'toolCallId', 'toolName'])) return false;
  return value.version === 1 && typeof value.artifactId === 'string' && ARTIFACT_ID.test(value.artifactId)
    && value.projectId === projectId && safeId(value.runId)
    && (value.kind === 'tool-result'
      || value.kind === 'checkpoint-source'
      || value.kind === 'server-run-draft')
    && typeof value.bodySha256 === 'string' && SHA256.test(value.bodySha256)
    && integer(value.originalBytes) && value.originalBytes <= MAX_ARTIFACT_BYTES
    && integer(value.originalChars) && integer(value.createdAt) && typeof value.redacted === 'boolean'
    && typeof value.binaryOmitted === 'boolean' && string(value.body, MAX_ARTIFACT_BYTES)
    && optionalString(value.toolCallId, 512) && optionalString(value.toolName, 256);
}

function sameArtifactIndex(index: AgentArtifactIndexEntry, artifact: AgentArtifactRecord): boolean {
  const { version: _version, body: _body, ...recordIndex } = artifact;
  const left = index as Record<string, unknown>;
  const right = recordIndex as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => Object.is(right[key], value));
}

function validateCounts(sidecar: AgentRuntimeSidecar, artifacts: readonly AgentArtifactRecord[]): void {
  if (sidecar.runs.length > MAX_RUNTIME_RUNS || sidecar.approvals.length > MAX_APPROVALS
    || sidecar.checkpoints.length > MAX_CHECKPOINTS + MAX_RUNTIME_RUNS
    || sidecar.artifacts.length > MAX_PROJECT_ARTIFACTS || artifacts.length > MAX_PROJECT_ARTIFACTS) {
    throw new Error('Agent runtime transfer exceeds record caps.');
  }
  const runtimeBytes = encoder.encode(JSON.stringify(sidecar)).byteLength;
  const artifactBytes = artifacts.reduce((sum, artifact) => sum + artifact.originalBytes, 0);
  if (runtimeBytes > MAX_RUNTIME_BYTES || artifactBytes > MAX_PROJECT_ARTIFACT_BYTES) {
    throw new Error('Agent runtime transfer exceeds byte caps.');
  }
}

export async function validateRuntime(snapshot: AgentRuntimeSnapshot): Promise<void> {
  const { sidecar, artifacts } = snapshot;
  if (!isRecord(sidecar) || !allowedKeys(sidecar, ['version', 'revision', 'projectId', 'durability',
    'updatedAt', 'lastWriterId', 'sessionGeneration', 'runs', 'approvals', 'checkpoints', 'artifacts'])
    || sidecar.version !== 1 || typeof sidecar.projectId !== 'string'
    || !PROJECT_ID.test(sidecar.projectId) || sidecar.durability !== 'local-sidecar'
    || !integer(sidecar.revision) || !integer(sidecar.updatedAt)
    || (sidecar.lastWriterId !== undefined && !safeId(sidecar.lastWriterId))
    || (sidecar.sessionGeneration !== undefined && !safeId(sidecar.sessionGeneration))
    || !Array.isArray(sidecar.runs) || !Array.isArray(sidecar.approvals)
    || !Array.isArray(sidecar.checkpoints) || !Array.isArray(sidecar.artifacts)
    || !Array.isArray(artifacts)) throw new Error('Invalid Agent runtime sidecar.');
  validateCounts(sidecar, artifacts);
  if (!sidecar.runs.every((run) => validRun(run, sidecar.projectId))
    || !sidecar.approvals.every((row) => validApproval(row, sidecar.projectId))
    || !sidecar.checkpoints.every((row) => validCheckpoint(row, sidecar.projectId))
    || !sidecar.artifacts.every((row) => validArtifact({ ...row, version: 1, body: '' }, sidecar.projectId))
    || !artifacts.every((row) => validArtifact(row, sidecar.projectId))) throw new Error('Invalid Agent runtime record shape.');

  const runs = new Map(sidecar.runs.map((run) => [run.runId, run]));
  const approvals = new Map(sidecar.approvals.map((row) => [row.approvalId, row]));
  const checkpoints = new Map(sidecar.checkpoints.map((row) => [row.checkpointId, row]));
  const artifactRecords = new Map(artifacts.map((row) => [row.artifactId, row]));
  const eventIds = new Set(sidecar.runs.flatMap((run) => run.events.map((event) => event.eventId)));
  const eventCount = sidecar.runs.reduce((sum, run) => sum + run.events.length, 0);
  if (runs.size !== sidecar.runs.length || approvals.size !== sidecar.approvals.length
    || checkpoints.size !== sidecar.checkpoints.length || artifactRecords.size !== artifacts.length
    || eventIds.size !== eventCount) throw new Error('Duplicate Agent runtime ids.');
  const indexes = new Map(sidecar.artifacts.map((row) => [row.artifactId, row]));
  if (indexes.size !== sidecar.artifacts.length || indexes.size !== artifactRecords.size) {
    throw new Error('Agent artifact index closure is incomplete.');
  }
  for (const run of sidecar.runs) validateRunClosure(run, approvals, checkpoints, artifactRecords);
  for (const approval of sidecar.approvals) {
    if (!runs.has(approval.runId)) throw new Error('Agent approval references a missing run.');
  }
  for (const checkpoint of sidecar.checkpoints) {
    await validateCheckpointClosure(checkpoint, runs, artifactRecords);
  }
  for (const artifact of artifacts) {
    if (!runs.has(artifact.runId) || !runs.get(artifact.runId)!.artifactIds.includes(artifact.artifactId)
      || !sameArtifactIndex(indexes.get(artifact.artifactId)!, artifact)
      || encoder.encode(artifact.body).byteLength !== artifact.originalBytes
      || artifact.body.length !== artifact.originalChars || await sha256Text(artifact.body) !== artifact.bodySha256) {
      throw new Error('Agent artifact integrity validation failed.');
    }
  }
}

function validateRunClosure(
  run: AgentRunRecord,
  approvals: ReadonlyMap<string, AgentApprovalRecord>,
  checkpoints: ReadonlyMap<string, AgentCheckpointRecord>,
  artifacts: ReadonlyMap<string, AgentArtifactRecord>,
): void {
  for (const id of run.checkpointIds) if (checkpoints.get(id)?.runId !== run.runId) throw new Error('Agent run checkpoint closure is incomplete.');
  for (const id of run.artifactIds) if (artifacts.get(id)?.runId !== run.runId) throw new Error('Agent run artifact closure is incomplete.');
  if (run.context?.checkpointId && checkpoints.get(run.context.checkpointId)?.runId !== run.runId) throw new Error('Agent run context checkpoint is missing.');
  for (const event of run.events) {
    if (event.approvalId && approvals.get(event.approvalId)?.runId !== run.runId) throw new Error('Agent event approval is missing.');
    if (event.checkpointId && checkpoints.get(event.checkpointId)?.runId !== run.runId) throw new Error('Agent event checkpoint is missing.');
    const id = event.outcome?.artifactId;
    if (id && artifacts.get(id)?.runId !== run.runId) throw new Error('Agent event artifact is missing.');
    if (id && event.resultDigest && artifacts.get(id)?.bodySha256 !== event.resultDigest) {
      throw new Error('Agent event artifact digest does not match.');
    }
  }
}

async function validateCheckpointClosure(
  checkpoint: AgentCheckpointRecord,
  runs: ReadonlyMap<string, AgentRunRecord>,
  artifacts: ReadonlyMap<string, AgentArtifactRecord>,
): Promise<void> {
  const source = artifacts.get(checkpoint.sourceArtifactId);
  if (!runs.has(checkpoint.runId) || !runs.get(checkpoint.runId)!.checkpointIds.includes(checkpoint.checkpointId)
    || !source || source.runId !== checkpoint.runId || source.kind !== 'checkpoint-source'
    || source.bodySha256 !== checkpoint.sourceDigest || await sha256Text(source.body) !== checkpoint.sourceDigest
    || (checkpoint.summaryDigest && await sha256Text(checkpoint.summary) !== checkpoint.summaryDigest)) {
    throw new Error('Agent checkpoint integrity validation failed.');
  }
}

export function chatArtifactReferences(chat: PersistedChat | undefined): Set<string> {
  const artifacts = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!isRecord(value)) return;
    if ('artifactId' in value) {
      if (typeof value.artifactId !== 'string' || !ARTIFACT_ID.test(value.artifactId)) {
        throw new Error('Invalid Agent artifact id in chat.');
      }
      artifacts.add(value.artifactId);
    }
    for (const item of Object.values(value)) visit(item);
  };
  if (chat) visit(chat);
  return artifacts;
}

export async function validateChatClosure(snapshot: AgentRuntimeSnapshot, chat: PersistedChat | undefined): Promise<void> {
  if (chat) {
    const artifacts = new Map(snapshot.artifacts.map((row) => [row.artifactId, row]));
    await verifyCanonicalContextCheckpoint(
      chat.llm as ModelMessage[],
      snapshot.sidecar.checkpoints,
      async (artifactId) => artifacts.get(artifactId) ?? null,
    );
  }
  const available = new Set(snapshot.artifacts.map((row) => row.artifactId));
  for (const id of chatArtifactReferences(chat)) {
    if (!available.has(id)) throw new Error('Saved chat artifact linkage is incomplete.');
  }
}
