import { isProjectStoreRecord as isRecord } from '../../shared/project-store-validation';
import type { PersistedChat } from './projectStore';
import {
  loadAgentArtifact, loadAgentRuntimeSidecar, MAX_ARTIFACT_BYTES, MAX_PROJECT_ARTIFACT_BYTES,
  MAX_PROJECT_ARTIFACTS, publishAgentRuntimeSnapshot, sha256Text,
  type AgentArtifactRecord, type AgentRuntimeSidecar, type AgentRuntimeSnapshot,
} from './agentRuntimeStore';
import type { StoredProposalRecord } from './proposalStore';
import {
  projectPortableAgentRuntimeSnapshot,
  rescopeAgentRuntimeSnapshot,
  validateProposalRuntimeTransfer,
} from './agentRuntimeTransferScope';
import {
  allowedKeys, chatArtifactReferences, integer, MAX_RUNTIME_BYTES, validArtifact,
  validateChatClosure, validateRuntime,
} from './agentRuntimeTransferValidation';
export {
  rescopeAgentRuntimeSnapshot as rescopeAgentRuntime,
  validateProposalRuntimeTransfer,
};

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CHUNK_BYTES = 48 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type AgentRuntimeStreamRecord = Record<string, unknown>;

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

interface PendingBytes {
  expected: number;
  parts: Uint8Array[];
  bytes: number;
  maxParts: number;
  sha256: string;
}

export class AgentRuntimeImportReader {
  private runtime: PendingBytes | null = null;
  private sidecar: AgentRuntimeSidecar | null = null;
  private artifact: {
    metadata: Omit<AgentArtifactRecord, 'body'>;
    parts: Uint8Array[];
    bytes: number;
    maxParts: number;
  } | null = null;
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
    this.runtime = {
      expected: row.bytes,
      parts: [],
      bytes: 0,
      maxParts: Math.ceil(row.bytes / MAX_CHUNK_BYTES),
      sha256: row.sha256,
    };
    return true;
  }

  private runtimeChunk(row: Record<string, unknown>): true {
    if (!allowedKeys(row, ['type', 'data']) || !this.runtime || this.sidecar) {
      throw new Error('Agent runtime chunk order is invalid.');
    }
    const bytes = decodeBase64(row.data);
    if (this.runtime.parts.length >= this.runtime.maxParts) {
      throw new Error('Agent runtime chunk count exceeds cap.');
    }
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
    this.artifact = {
      metadata: metadata as unknown as Omit<AgentArtifactRecord, 'body'>,
      parts: [],
      bytes: 0,
      maxParts: Math.ceil(metadata.originalBytes / MAX_CHUNK_BYTES),
    };
    return true;
  }

  private artifactChunk(row: Record<string, unknown>): true {
    if (!allowedKeys(row, ['type', 'data']) || !this.artifact) {
      throw new Error('Agent artifact chunk order is invalid.');
    }
    const bytes = decodeBase64(row.data);
    if (this.artifact.parts.length >= this.artifact.maxParts) {
      throw new Error('Agent artifact chunk count exceeds cap.');
    }
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

  async finish(chat?: PersistedChat, required = false): Promise<AgentRuntimeSnapshot | null> {
    if (!this.started) {
      if (required) throw new Error('Agent runtime transfer is missing.');
      return null;
    }
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
