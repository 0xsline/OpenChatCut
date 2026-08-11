import {
  loadAgentArtifact,
  MAX_ARTIFACT_BYTES,
  sha256Text,
  storeAgentArtifact,
  type AgentArtifactRecord,
  type AgentToolOutcome,
} from '../persist/agentRuntimeStore';
import {
  redactTextForAgentRuntime,
  sanitizeJsonForArtifact,
  type AgentArtifactRef,
} from './runtime-artifact';

export const TOOL_ARTIFACT_THRESHOLD = 16_000;
export const PREVIEW_CHARS = 800;
const SUMMARY_CHARS = 1_200;

function canonicalValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const next = Array.isArray(value)
    ? value.map((item) => canonicalValue(item, seen))
    : Object.fromEntries(Object.keys(value as object).sort().map((key) => [
      key, canonicalValue((value as Record<string, unknown>)[key], seen),
    ]));
  seen.delete(value);
  return next;
}

export async function digestAgentToolArgs(args: Record<string, unknown>): Promise<string> {
  let canonical: string | undefined;
  try { canonical = JSON.stringify(canonicalValue(args)); } catch { throw new Error('tool_args_identity: arguments could not be canonicalized safely'); }
  if (canonical === undefined) throw new Error('tool_args_identity: arguments could not be canonicalized safely');
  return sha256Text(canonical);
}

export function sanitizeText(value: unknown, maxChars = SUMMARY_CHARS): string {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = redactTextForAgentRuntime(text)
    .replace(/\b(token|api[-_]?key|authorization|cookie|password|secret|credential)\s*(?::|=|\bis\b)\s*([^\s,;]+)/gi, '$1=[REDACTED]');
  return text.trim().slice(0, maxChars);
}

export function sanitizeOutcomeForPersistence(outcome: AgentToolOutcome): AgentToolOutcome {
  return {
    kind: outcome.kind,
    ...(outcome.code === undefined ? {} : { code: sanitizeText(outcome.code, 240) }),
    ...(outcome.operationId === undefined ? {} : { operationId: outcome.operationId }),
    ...(outcome.artifactId === undefined ? {} : { artifactId: outcome.artifactId }),
    ...(outcome.summary === undefined ? {} : { summary: sanitizeText(outcome.summary) }),
  };
}

export async function uniqueArtifactId(projectId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 18);
    if (!await loadAgentArtifact(projectId, id)) return id;
  }
  throw new Error('Unable to allocate a unique agent artifact id.');
}

export function artifactRef(record: AgentArtifactRecord): AgentArtifactRef {
  return {
    artifactId: record.artifactId,
    bodySha256: record.bodySha256,
    originalChars: record.originalChars,
    storedBytes: record.originalBytes,
    redacted: record.redacted,
    binaryOmitted: record.binaryOmitted,
  };
}

export async function archiveAgentToolResult(
  projectId: string,
  runId: string,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly result: unknown;
    readonly forceArchive?: boolean;
  },
): Promise<AgentArtifactRef | null> {
  if (!input.forceArchive
      && (input.toolName === 'read_agent_artifact' || input.toolName === 'load_skill')) return null;
  const sanitized = sanitizeJsonForArtifact(input.result);
  if (!sanitized) throw new Error('tool_result_archive: result could not be serialized safely');
  if (sanitized.originalChars <= TOOL_ARTIFACT_THRESHOLD) return null;
  if (sanitized.storedBytes > MAX_ARTIFACT_BYTES) {
    throw new Error('tool_result_archive: result exceeds the per-artifact storage limit');
  }
  const bodySha256 = await sha256Text(sanitized.body);
  const artifactId = await uniqueArtifactId(projectId);
  const record: AgentArtifactRecord = {
    version: 1, artifactId, projectId, runId,
    kind: 'tool-result', toolCallId: input.toolCallId, toolName: input.toolName,
    bodySha256, originalBytes: sanitized.storedBytes,
    originalChars: sanitized.originalChars, createdAt: Date.now(),
    redacted: sanitized.redacted, binaryOmitted: sanitized.binaryOmitted,
    body: sanitized.body,
  };
  if (!await storeAgentArtifact(record)) {
    throw new Error('tool_result_archive: artifact storage is unavailable');
  }
  return artifactRef(record);
}
