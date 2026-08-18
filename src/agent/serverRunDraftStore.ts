import type { AgentReference } from './context';
import type { AnyAction } from '../editor/store';
import { replayActions } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { migrateProjectDoc } from '../persist/projectStore';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  MAX_ARTIFACT_BYTES,
  sha256Text,
} from '../persist/agentRuntimeStore';
import {
  projectToolResultForPersistence,
  sanitizeJsonForArtifact,
} from './runtime-artifact';
import { SERVER_RUN_CAPABILITY_HEADER } from './serverRunProtocol';
import { readStoredServerRun } from './serverRunSessionStorage';

function storedRunCapabilityHeader(projectId: string, runId: string): Record<string, string> {
  const stored = readStoredServerRun(projectId);
  const capability = stored?.runId === runId ? stored.capability : undefined;
  return capability ? { [SERVER_RUN_CAPABILITY_HEADER]: capability } : {};
}

interface ServerRunDraftBaseBody {
  readonly version: 1;
  readonly kind: 'base';
  readonly text: string;
  readonly content: string;
  readonly askOnly: boolean;
  readonly references: readonly AgentReference[];
  readonly baseDoc: ProjectDoc;
}

export interface ServerRunDraftToolBody {
  readonly version: 1;
  readonly kind: 'tool';
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: string;
  readonly actions: readonly AnyAction[];
}

export interface ServerRunDraft {
  readonly base: ServerRunDraftBaseBody;
  readonly tools: readonly ServerRunDraftToolBody[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validReference(value: unknown): value is AgentReference {
  const item = record(value);
  return !!item && typeof item.id === 'string'
    && typeof item.name === 'string' && typeof item.kind === 'string';
}

function validActions(value: unknown): value is AnyAction[] {
  return Array.isArray(value) && value.every((action) => {
    const item = record(action);
    return !!item && typeof item.type === 'string';
  });
}

function parseBase(value: unknown): ServerRunDraftBaseBody | null {
  const item = record(value);
  if (!item || item.version !== 1 || item.kind !== 'base'
    || typeof item.text !== 'string' || typeof item.content !== 'string'
    || typeof item.askOnly !== 'boolean' || !Array.isArray(item.references)
    || !item.references.every(validReference)) return null;
  const baseDoc = migrateProjectDoc(item.baseDoc);
  if (!baseDoc) return null;
  return {
    version: 1,
    kind: 'base',
    text: item.text,
    content: item.content,
    askOnly: item.askOnly,
    references: item.references,
    baseDoc,
  };
}

function parseTool(value: unknown): ServerRunDraftToolBody | null {
  const item = record(value);
  if (!item || item.version !== 1 || item.kind !== 'tool'
    || typeof item.toolCallId !== 'string' || typeof item.argsDigest !== 'string'
    || typeof item.name !== 'string' || !record(item.args) || !validActions(item.actions)
    || (item.error !== undefined && typeof item.error !== 'string')
    || (item.error === undefined && !Object.hasOwn(item, 'result'))) return null;
  return {
    version: 1,
    kind: 'tool',
    toolCallId: item.toolCallId,
    argsDigest: item.argsDigest,
    name: item.name,
    args: item.args as Record<string, unknown>,
    ...(item.error === undefined ? { result: item.result } : { error: item.error }),
    actions: item.actions,
  };
}

function artifactId(): string {
  return `srd_${crypto.randomUUID().replaceAll('-', '').slice(0, 15)}`;
}

async function storeBody(
  projectId: string,
  runId: string,
  body: ServerRunDraftBaseBody | ServerRunDraftToolBody,
): Promise<void> {
  const sanitized = sanitizeJsonForArtifact(body);
  if (!sanitized) throw new Error('Server run draft could not be sanitized.');
  if (sanitized.storedBytes > MAX_ARTIFACT_BYTES) {
    throw new Error('Server run draft exceeds the durable artifact limit.');
  }
  const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/draft`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...storedRunCapabilityHeader(projectId, runId),
    },
    body: JSON.stringify({
      projectId,
      artifact: {
        artifactId: artifactId(),
        bodySha256: await sha256Text(sanitized.body),
        originalBytes: sanitized.storedBytes,
        originalChars: sanitized.originalChars,
        redacted: sanitized.redacted,
        binaryOmitted: sanitized.binaryOmitted,
        body: sanitized.body,
        ...(body.kind === 'tool'
          ? { toolCallId: body.toolCallId, toolName: body.name }
          : { toolName: 'server_run_draft_base' }),
      },
    }),
  });
  if (!response.ok) {
    const hint = response.status === 403
      ? 'the run capability was lost (new tab or reload); start a new run'
      : response.status === 404
        ? 'the run no longer exists on the server'
        : `HTTP ${response.status}`;
    throw new Error(`Server run draft could not be persisted (${hint}).`);
  }
}

export function saveServerRunDraftBase(
  projectId: string,
  runId: string,
  input: Omit<ServerRunDraftBaseBody, 'version' | 'kind'>,
): Promise<void> {
  return storeBody(projectId, runId, { version: 1, kind: 'base', ...input });
}

export function saveServerRunDraftTool(
  projectId: string,
  runId: string,
  input: Omit<ServerRunDraftToolBody, 'version' | 'kind' | 'result'> & {
    readonly result?: unknown;
  },
): Promise<void> {
  return storeBody(projectId, runId, {
    version: 1,
    kind: 'tool',
    ...input,
    ...(input.error === undefined
      ? { result: projectToolResultForPersistence(input.result) }
      : { error: input.error }),
  });
}
export async function clearServerRunDraft(projectId: string, runId: string): Promise<void> {
  try {
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/draft/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...storedRunCapabilityHeader(projectId, runId),
      },
      body: JSON.stringify({ projectId }),
    });
    if (!response.ok) throw new Error('draft clear rejected');
  } catch {
    // Best-effort cleanup; stale drafts are pruned by retention on the next write.
  }
}


export async function loadServerRunDraft(projectId: string, runId: string): Promise<ServerRunDraft | null> {
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const indexes = sidecar.artifacts
    .filter((item) => item.runId === runId && item.kind === 'server-run-draft')
    .sort((left, right) => left.createdAt - right.createdAt);
  const records = await Promise.all(indexes.map((item) => loadAgentArtifact(projectId, item.artifactId)));
  let base: ServerRunDraftBaseBody | null = null;
  const tools = new Map<string, ServerRunDraftToolBody>();
  for (const artifact of records) {
    if (!artifact) throw new Error('Server run draft artifact is unavailable.');
    let value: unknown;
    try { value = JSON.parse(artifact.body); } catch { throw new Error('Server run draft artifact is invalid.'); }
    const nextBase = parseBase(value);
    if (nextBase) {
      if (base) throw new Error('Server run draft contains multiple base snapshots.');
      base = nextBase;
      continue;
    }
    const tool = parseTool(value);
    if (!tool) throw new Error('Server run draft artifact is invalid.');
    const previous = tools.get(tool.toolCallId);
    if (previous && previous.argsDigest !== tool.argsDigest) {
      throw new Error('Server run draft contains conflicting tool calls.');
    }
    tools.set(tool.toolCallId, tool);
  }
  if (!base) return null;
  let doc = base.baseDoc;
  for (const tool of tools.values()) doc = replayActions(doc, [...tool.actions]);
  void doc;
  return { base, tools: [...tools.values()] };
}
