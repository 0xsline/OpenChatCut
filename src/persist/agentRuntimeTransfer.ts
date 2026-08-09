import { isProjectStoreRecord as isRecord } from '../../shared/project-store-validation';
import type { ModelMessage } from 'ai';
import { verifyCanonicalContextCheckpoint } from '../agent/context-compaction';
import type { PersistedChat } from './projectStore';
import {
  loadAgentArtifact, loadAgentRuntimeSidecar, MAX_AGENT_RUNS, MAX_APPROVALS,
  MAX_ARTIFACT_BYTES, MAX_CHECKPOINTS, MAX_EVENTS_PER_RUN, MAX_PROJECT_ARTIFACT_BYTES,
  MAX_PROJECT_ARTIFACTS, publishAgentRuntimeSnapshot, sha256Text,
  type AgentApprovalRecord, type AgentArtifactIndexEntry, type AgentArtifactRecord,
  type AgentCheckpointRecord, type AgentRunEvent, type AgentRunRecord,
  type AgentRuntimeSidecar, type AgentRuntimeSnapshot,
} from './agentRuntimeStore';
import type { StoredProposalRecord } from './proposalStore';
import {
  projectPortableAgentRuntimeSnapshot,
  rescopeAgentRuntimeSnapshot,
  validateProposalRuntimeTransfer,
} from './agentRuntimeTransferScope';
export {
  rescopeAgentRuntimeSnapshot as rescopeAgentRuntime,
  validateProposalRuntimeTransfer,
};

const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RUNTIME_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 48 * 1024;
const MAX_RUNTIME_RUNS = MAX_AGENT_RUNS + MAX_APPROVALS;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type AgentRuntimeStreamRecord = Record<string, unknown>;

const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum;
const string = (value: unknown, max = 262_144): value is string =>
  typeof value === 'string' && value.length <= max;
const safeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);
const optionalString = (value: unknown, max?: number): boolean => value === undefined || string(value, max);
const optionalSha = (value: unknown): boolean => value === undefined || (typeof value === 'string' && SHA256.test(value));
const uniqueStrings = (value: unknown, pattern = SAFE_ID): value is string[] =>
  Array.isArray(value) && value.length === new Set(value).size
  && value.every((item) => typeof item === 'string' && pattern.test(item));
const allowedKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
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
  if (!isRecord(value) || !allowedKeys(value, ['requestShapeHash', 'systemTokens', 'toolSchemaChars',
    'historyTokens', 'activeToolCount', 'toolSchemaCount', 'checkpointId', 'inputTokens', 'outputTokens',
    'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'noCacheTokens'])) return false;
  if (typeof value.requestShapeHash !== 'string' || !SHA256.test(value.requestShapeHash)) return false;
  return Object.entries(value).every(([key, item]) => key === 'requestShapeHash'
    || (key === 'checkpointId' ? safeId(item) : integer(item)));
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

function validArtifact(value: unknown, projectId: string): value is AgentArtifactRecord {
  if (!isRecord(value) || !allowedKeys(value, ['version', 'artifactId', 'projectId', 'runId', 'kind',
    'bodySha256', 'originalBytes', 'originalChars', 'createdAt', 'redacted', 'binaryOmitted', 'body',
    'toolCallId', 'toolName'])) return false;
  return value.version === 1 && typeof value.artifactId === 'string' && ARTIFACT_ID.test(value.artifactId)
    && value.projectId === projectId && safeId(value.runId)
    && (value.kind === 'tool-result' || value.kind === 'checkpoint-source')
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

async function validateRuntime(snapshot: AgentRuntimeSnapshot): Promise<void> {
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

function chatArtifactReferences(chat: PersistedChat | undefined): Set<string> {
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

async function validateChatClosure(snapshot: AgentRuntimeSnapshot, chat: PersistedChat | undefined): Promise<void> {
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


export async function loadAgentRuntimeTransfer(
  projectId: string,
  chat?: PersistedChat,
  proposal?: StoredProposalRecord,
): Promise<AgentRuntimeSnapshot | null> {
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const artifactRefs = chatArtifactReferences(chat);
  if (!sidecar.runs.length && !sidecar.approvals.length
      && !sidecar.checkpoints.length && !sidecar.artifacts.length) {
    if (artifactRefs.size) throw new Error('Saved chat references missing Agent runtime data.');
    validateProposalRuntimeTransfer(null, proposal);
    return null;
  }
  const artifacts: AgentArtifactRecord[] = [];
  for (const index of sidecar.artifacts) {
    const artifact = await loadAgentArtifact(projectId, index.artifactId);
    if (!artifact) throw new Error(`Agent artifact is missing or corrupt: ${index.artifactId}`);
    artifacts.push(artifact);
  }
  const snapshot = { sidecar, artifacts };
  await validateRuntime(snapshot);
  await validateChatClosure(snapshot, chat);
  validateProposalRuntimeTransfer(snapshot, proposal);
  return snapshot;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4
    || !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid Agent runtime chunk.');
  const binary = atob(value);
  if (binary.length > MAX_CHUNK_BYTES) throw new Error('Agent runtime chunk exceeds cap.');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function* encodedChunks(bytes: Uint8Array): Generator<string> {
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
    yield base64(bytes.subarray(offset, Math.min(bytes.length, offset + MAX_CHUNK_BYTES)));
  }
}

export async function* agentRuntimeRecords(snapshot: AgentRuntimeSnapshot): AsyncGenerator<AgentRuntimeStreamRecord> {
  await validateRuntime(snapshot);
  const portable = projectPortableAgentRuntimeSnapshot(snapshot);
  await validateRuntime(portable);
  const runtimeBytes = encoder.encode(JSON.stringify(portable.sidecar));
  const runtimeSha256 = await sha256Text(decoder.decode(runtimeBytes));
  yield { type: 'agent-runtime-start', bytes: runtimeBytes.byteLength, sha256: runtimeSha256 };
  for (const data of encodedChunks(runtimeBytes)) yield { type: 'agent-runtime-chunk', data };
  yield { type: 'agent-runtime-end', sha256: runtimeSha256 };
  for (const artifact of portable.artifacts) {
    const { body, ...metadata } = artifact;
    yield { type: 'agent-artifact-start', ...metadata };
    for (const data of encodedChunks(encoder.encode(body))) yield { type: 'agent-artifact-chunk', data };
    yield { type: 'agent-artifact-end', artifactId: artifact.artifactId, bodySha256: artifact.bodySha256 };
  }
}

interface PendingBytes { expected: number; parts: Uint8Array[]; bytes: number; sha256: string }

export class AgentRuntimeImportReader {
  private runtime: PendingBytes | null = null;
  private sidecar: AgentRuntimeSidecar | null = null;
  private artifact: { metadata: Omit<AgentArtifactRecord, 'body'>; parts: Uint8Array[]; bytes: number } | null = null;
  private readonly artifacts: AgentArtifactRecord[] = [];
  private started = false;
  private artifactBytes = 0;

  async consume(value: unknown): Promise<boolean> {
    if (!isRecord(value) || typeof value.type !== 'string' || !value.type.startsWith('agent-')) return false;
    if (value.type === 'agent-runtime-start') return this.startRuntime(value);
    if (value.type === 'agent-runtime-chunk') return this.runtimeChunk(value);
    if (value.type === 'agent-runtime-end') return this.endRuntime(value);
    if (value.type === 'agent-artifact-start') return this.startArtifact(value);
    if (value.type === 'agent-artifact-chunk') return this.artifactChunk(value);
    if (value.type === 'agent-artifact-end') return this.endArtifact(value);
    throw new Error('Unknown Agent runtime transfer record.');
  }

  private startRuntime(row: Record<string, unknown>): true {
    if (!allowedKeys(row, ['type', 'bytes', 'sha256']) || this.started
      || !integer(row.bytes) || row.bytes > MAX_RUNTIME_BYTES
      || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) throw new Error('Invalid Agent runtime start record.');
    this.started = true;
    this.runtime = { expected: row.bytes, parts: [], bytes: 0, sha256: row.sha256 };
    return true;
  }

  private runtimeChunk(row: Record<string, unknown>): true {
    if (!allowedKeys(row, ['type', 'data']) || !this.runtime || this.sidecar) {
      throw new Error('Agent runtime chunk order is invalid.');
    }
    const bytes = decodeBase64(row.data);
    this.runtime.bytes += bytes.byteLength;
    if (this.runtime.bytes > this.runtime.expected) throw new Error('Agent runtime exceeds declared size.');
    this.runtime.parts.push(bytes);
    return true;
  }

  private async endRuntime(row: Record<string, unknown>): Promise<true> {
    if (!allowedKeys(row, ['type', 'sha256']) || !this.runtime
      || this.runtime.bytes !== this.runtime.expected || row.sha256 !== this.runtime.sha256) {
      throw new Error('Agent runtime end record does not match.');
    }
    const text = decoder.decode(joinBytes(this.runtime.parts, this.runtime.bytes));
    if (await sha256Text(text) !== this.runtime.sha256) throw new Error('Agent runtime hash mismatch.');
    try { this.sidecar = JSON.parse(text) as AgentRuntimeSidecar; } catch { throw new Error('Agent runtime JSON is invalid.'); }
    this.runtime = null;
    return true;
  }

  private startArtifact(row: Record<string, unknown>): true {
    if (!this.sidecar || this.artifact) throw new Error('Agent artifact record order is invalid.');
    const { type: _type, ...metadata } = row;
    if (!validArtifact({ ...metadata, body: '' }, this.sidecar.projectId)
      || !integer(metadata.originalBytes) || metadata.originalBytes > MAX_ARTIFACT_BYTES) {
      throw new Error('Invalid Agent artifact start record.');
    }
    this.artifact = { metadata: metadata as unknown as Omit<AgentArtifactRecord, 'body'>, parts: [], bytes: 0 };
    return true;
  }

  private artifactChunk(row: Record<string, unknown>): true {
    if (!allowedKeys(row, ['type', 'data']) || !this.artifact) {
      throw new Error('Agent artifact chunk order is invalid.');
    }
    const bytes = decodeBase64(row.data);
    this.artifact.bytes += bytes.byteLength;
    if (this.artifact.bytes > this.artifact.metadata.originalBytes) throw new Error('Agent artifact exceeds declared size.');
    this.artifact.parts.push(bytes);
    return true;
  }

  private async endArtifact(row: Record<string, unknown>): Promise<true> {
    if (!allowedKeys(row, ['type', 'artifactId', 'bodySha256']) || !this.artifact
      || row.artifactId !== this.artifact.metadata.artifactId
      || row.bodySha256 !== this.artifact.metadata.bodySha256
      || this.artifact.bytes !== this.artifact.metadata.originalBytes) {
      throw new Error('Agent artifact end record does not match.');
    }
    const body = decoder.decode(joinBytes(this.artifact.parts, this.artifact.bytes));
    const record = { ...this.artifact.metadata, body } as AgentArtifactRecord;
    if (await sha256Text(body) !== record.bodySha256) throw new Error('Agent artifact hash mismatch.');
    this.artifactBytes += record.originalBytes;
    if (this.artifacts.length >= MAX_PROJECT_ARTIFACTS
      || this.artifactBytes > MAX_PROJECT_ARTIFACT_BYTES) throw new Error('Agent artifact transfer exceeds caps.');
    this.artifacts.push(record);
    this.artifact = null;
    return true;
  }

  async finish(chat?: PersistedChat): Promise<AgentRuntimeSnapshot | null> {
    if (!this.started) return null;
    if (this.runtime || this.artifact || !this.sidecar) throw new Error('Agent runtime transfer is truncated.');
    const snapshot = { sidecar: this.sidecar, artifacts: this.artifacts };
    await validateRuntime(snapshot);
    await validateChatClosure(snapshot, chat);
    return snapshot;
  }
}

function joinBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  return joined;
}


export async function publishTransferredAgentRuntime(
  snapshot: AgentRuntimeSnapshot,
  projectId: string,
  proposal?: StoredProposalRecord,
): Promise<void> {
  const rescoped = rescopeAgentRuntimeSnapshot(snapshot, projectId, proposal);
  await validateRuntime(rescoped);
  await publishAgentRuntimeSnapshot(rescoped);
}
