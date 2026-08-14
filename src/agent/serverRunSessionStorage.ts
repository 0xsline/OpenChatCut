import type { AgentReference } from './context';

export interface StoredToolAttempt {
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly name?: string;
  readonly status?: 'result' | 'error';
  readonly result?: unknown;
  readonly error?: string;
}

export interface StoredServerRun {
  readonly projectId: string;
  readonly runId: string;
  readonly capability?: string;
  readonly leaseToken?: string;
  readonly createdAt?: number;
  readonly admissionPending?: boolean;
  readonly text?: string;
  readonly content?: string;
  readonly askOnly?: boolean;
  readonly references?: readonly AgentReference[];
  readonly activeToolNames?: readonly string[];
  readonly cursor?: number;
  readonly modelHistoryLength?: number;
  readonly assistantText?: string;
  readonly assistantThinking?: string;
  readonly attempts?: readonly StoredToolAttempt[];
}

const runKey = (projectId: string): string => `cc.serverRun.${projectId}`;
const claimKey = (projectId: string): string => `cc.serverRunClaim.${projectId}`;

function reference(value: unknown): value is AgentReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.kind === 'string';
}

function attempt(value: unknown): value is StoredToolAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.toolCallId !== 'string' || typeof item.argsDigest !== 'string') return false;
  if (item.status === undefined) return true;
  if (typeof item.name !== 'string' || item.name.length === 0) return false;
  if (item.status === 'result') return Object.hasOwn(item, 'result');
  return item.status === 'error' && typeof item.error === 'string';
}

function toolNames(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((name) => typeof name === 'string');
}

export function readStoredServerRun(projectId: string): StoredServerRun | null {
  try {
    const stored = sessionStorage.getItem(runKey(projectId));
    if (!stored) return null;
    if (!stored.startsWith('{')) return { projectId, runId: stored };
    const parsed = JSON.parse(stored) as Partial<StoredServerRun>;
    if (parsed.projectId !== projectId || typeof parsed.runId !== 'string') return null;
    return {
      projectId,
      runId: parsed.runId,
      ...(typeof parsed.capability === 'string' && parsed.capability.length > 0
        ? { capability: parsed.capability }
        : {}),
      ...(typeof parsed.leaseToken === 'string' && parsed.leaseToken.length > 0
        ? { leaseToken: parsed.leaseToken }
        : {}),
      ...(Number.isSafeInteger(parsed.createdAt) && (parsed.createdAt ?? -1) >= 0
        ? { createdAt: parsed.createdAt }
        : {}),
      ...(typeof parsed.admissionPending === 'boolean'
        ? { admissionPending: parsed.admissionPending }
        : {}),
      ...(typeof parsed.text === 'string' ? { text: parsed.text } : {}),
      ...(typeof parsed.content === 'string' ? { content: parsed.content } : {}),
      ...(typeof parsed.askOnly === 'boolean' ? { askOnly: parsed.askOnly } : {}),
      ...(Array.isArray(parsed.references) && parsed.references.every(reference)
        ? { references: parsed.references }
        : {}),
      ...(toolNames(parsed.activeToolNames)
        ? { activeToolNames: parsed.activeToolNames }
        : {}),
      ...(Number.isSafeInteger(parsed.cursor) && (parsed.cursor ?? -1) >= 0
        ? { cursor: parsed.cursor }
        : {}),
      ...(Number.isSafeInteger(parsed.modelHistoryLength)
        && (parsed.modelHistoryLength ?? -1) >= 0
        ? { modelHistoryLength: parsed.modelHistoryLength }
        : {}),
      ...(typeof parsed.assistantText === 'string'
        ? { assistantText: parsed.assistantText }
        : {}),
      ...(typeof parsed.assistantThinking === 'string'
        ? { assistantThinking: parsed.assistantThinking }
        : {}),
      ...(Array.isArray(parsed.attempts) && parsed.attempts.every(attempt)
        ? { attempts: parsed.attempts }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveStoredServerRun(projectId: string, value: StoredServerRun): boolean {
  try {
    sessionStorage.setItem(runKey(projectId), JSON.stringify(value));
    return readStoredServerRun(projectId)?.runId === value.runId;
  } catch {
    return false;
  }
}

export function patchStoredServerRun(projectId: string, update: Partial<StoredServerRun>): boolean {
  const current = readStoredServerRun(projectId);
  return current ? saveStoredServerRun(projectId, { ...current, ...update }) : false;
}

export function clearStoredServerRunLease(
  projectId: string,
  runId: string,
  leaseToken: string,
): boolean {
  const stored = readStoredServerRun(projectId);
  if (stored?.runId !== runId || stored.leaseToken !== leaseToken) return false;
  const withoutLease = { ...stored };
  delete withoutLease.leaseToken;
  return saveStoredServerRun(projectId, withoutLease)
    && readStoredServerRun(projectId)?.leaseToken === undefined;
}

export function clearStoredServerRun(projectId: string, runId?: string): void {
  if (runId && readStoredServerRun(projectId)?.runId !== runId) return;
  try { sessionStorage.removeItem(runKey(projectId)); } catch { /* best effort */ }
}

export function storedClaimIdentity(projectId: string): string {
  try {
    const existing = sessionStorage.getItem(claimKey(projectId));
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(claimKey(projectId), created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function findStoredToolAttempt(
  projectId: string,
  toolCallId: string,
): StoredToolAttempt | undefined {
  return readStoredServerRun(projectId)?.attempts?.find((item) => item.toolCallId === toolCallId);
}

export function beginStoredToolAttempt(
  projectId: string,
  toolCallId: string,
  argsDigest: string,
): boolean {
  const stored = readStoredServerRun(projectId);
  if (!stored) return false;
  const attempts = [
    ...(stored.attempts ?? []).filter((item) => item.toolCallId !== toolCallId),
    { toolCallId, argsDigest },
  ];
  if (!saveStoredServerRun(projectId, { ...stored, attempts })) return false;
  return findStoredToolAttempt(projectId, toolCallId)?.argsDigest === argsDigest;
}

export function clearStoredToolAttempt(projectId: string, toolCallId: string): void {
  const stored = readStoredServerRun(projectId);
  if (!stored) return;
  void saveStoredServerRun(projectId, {
    ...stored,
    attempts: (stored.attempts ?? []).filter((item) => item.toolCallId !== toolCallId),
  });
}

export function captureStoredToolResult(
  projectId: string,
  toolCallId: string,
  outcome: { name: string; argsDigest: string; result?: unknown; error?: string },
): boolean {
  const stored = readStoredServerRun(projectId);
  const current = stored?.attempts?.find((item) => item.toolCallId === toolCallId);
  if (!stored || current?.argsDigest !== outcome.argsDigest) return false;
  const captured: StoredToolAttempt = outcome.error === undefined
    ? {
      toolCallId,
      argsDigest: outcome.argsDigest,
      name: outcome.name,
      status: 'result',
      result: outcome.result ?? null,
    }
    : {
      toolCallId,
      argsDigest: outcome.argsDigest,
      name: outcome.name,
      status: 'error',
      error: outcome.error,
    };
  const attempts = stored.attempts?.map((item) => (
    item.toolCallId === toolCallId ? captured : item
  ));
  return saveStoredServerRun(projectId, { ...stored, attempts })
    && findStoredToolAttempt(projectId, toolCallId)?.status === captured.status;
}
