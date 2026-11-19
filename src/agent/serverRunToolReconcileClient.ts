import { loadServerRunDraft, type ServerRunDraft } from './serverRunDraftStore';
import { revisionOf } from './external-edit-session';
import type { ProjectDoc } from '../editor/types';
import { policyForTool } from './execution-policy';
import {
  isFrozenVerdict,
  reconcileServerTool,
  type ServerToolReconcileDecision,
} from './serverRunToolReconcile';
import { loadServerRunMetadata, SERVER_RUN_CAPABILITY_HEADER, type ServerRunMetadata } from './serverRunProtocol';
import {
  clearStoredToolAttempt,
  readStoredServerRun,
  storedClaimIdentity,
  type StoredToolAttempt,
} from './serverRunSessionStorage';
import { projectServerRunToolResult } from './serverRunToolResult';

interface ExistingOutcome {
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly result?: unknown;
  readonly error?: string;
}

/** Evidence reads never execute tools or settle unknown effects as failures. */
export interface RunEvidenceRecheck {
  readonly blocked: boolean;
  readonly summary: string;
  readonly metadata: ServerRunMetadata;
  readonly existingOutcomes: readonly ExistingOutcome[];
  readonly decisions: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly decision: ServerToolReconcileDecision;
  }[];
}

export function collectRunEvidence(
  metadata: ServerRunMetadata,
  draft: ServerRunDraft | null,
  attempts: readonly StoredToolAttempt[],
  liveDoc: ProjectDoc,
): RunEvidenceRecheck {
  const durable = new Map((metadata.recovery?.tools ?? []).map((tool) => [tool.toolCallId, tool]));
  const drafts = new Map((draft?.tools ?? []).map((tool) => [tool.toolCallId, tool]));
  const stored = new Map(attempts.map((attempt) => [attempt.toolCallId, attempt]));
  const ids = new Set([...durable.keys(), ...drafts.keys(), ...stored.keys()]);
  const liveRevision = revisionOf(liveDoc);
  const baseRevision = draft ? revisionOf(draft.base.baseDoc) : liveRevision;
  const existingOutcomes: ExistingOutcome[] = [];
  const decisions = [...ids].map((toolCallId) => {
    const server = durable.get(toolCallId);
    const local = drafts.get(toolCallId);
    const attempt = stored.get(toolCallId);
    const argsDigest = local?.argsDigest ?? attempt?.argsDigest ?? server!.argsDigest;
    const name = local?.name ?? attempt?.name ?? server?.name ?? '未知工具';
    const saved = attempt?.argsDigest === argsDigest && attempt.status === 'error'
      ? { error: attempt.error! }
      : attempt?.argsDigest === argsDigest && attempt.status === 'result'
        ? { result: attempt.result }
        : local?.error !== undefined ? { error: local.error }
          : local && Object.hasOwn(local, 'result') ? { result: local.result }
            : null;
    const decision = reconcileServerTool({
      toolCallId,
      argsDigest,
      name,
      policy: policyForTool(name, local?.args).recovery,
      durable: server ? { ...server, state: server.state ?? 'intent' } : null,
      draft: local ?? null,
      draftTools: draft?.tools ?? [],
      stored: saved,
      liveRevision,
      baseRevision,
    });
    if (server?.state === 'claimed' && server.argsDigest === argsDigest && saved
      && !isFrozenVerdict(decision.verdict)) {
      existingOutcomes.push({ toolCallId, argsDigest, ...saved });
    }
    // A claimed read is safe to repeat, but only after the server explicitly
    // grants fresh authority. A read-only re-check cannot invent its outcome.
    const unresolvedClaim = server?.state === 'claimed' && !saved;
    return {
      toolCallId,
      name,
      decision: unresolvedClaim && !isFrozenVerdict(decision.verdict)
        ? { ...decision, verdict: 'outcome-unknown' as const,
          reason: `工具 ${name} 已取得执行权限，但还没有可补交的结果。` }
        : decision,
    };
  });
  const blockedDecisions = decisions.filter((entry) => isFrozenVerdict(entry.decision.verdict));
  const blocked = blockedDecisions.length > 0
    || (metadata.recovery?.state === 'waiting_reconcile' && existingOutcomes.length === 0);
  return {
    blocked,
    metadata,
    existingOutcomes: blockedDecisions.length > 0 ? [] : existingOutcomes,
    decisions,
    summary: blocked
      ? ['核对完成：仍有操作无法确认是否生效。',
        ...blockedDecisions.map((entry) => `· ${entry.decision.reason ?? entry.name}`),
        '需要继续等待可验证结果，或结束该任务。'].join('\n')
      : existingOutcomes.length
        ? '核对完成：已有工具结果可以补交，尚需服务端确认。'
        : '核对完成：现有证据足以确认上次操作已结束，可以继续。',
  };
}

export async function reconcileRunEvidence(
  projectId: string,
  runId: string,
  capability: string | undefined,
  liveDoc: ProjectDoc,
): Promise<RunEvidenceRecheck> {
  if (!capability) throw new Error('Stored server run capability is unavailable.');
  const metadata = await loadServerRunMetadata(projectId, runId, capability);
  // A failed evidence read is retryable; an empty draft must never stand in
  // for a failed read and turn an unknown effect into permission to execute.
  const draft = await loadServerRunDraft(projectId, runId);
  const stored = readStoredServerRun(projectId);
  return collectRunEvidence(metadata, draft, stored?.runId === runId ? stored.attempts ?? [] : [], liveDoc);
}

/** Submit only results that already exist, retaining evidence until acknowledged. */
export async function submitExistingRunOutcomes(
  projectId: string,
  runId: string,
  capability: string,
  evidence: RunEvidenceRecheck,
  active: () => boolean,
): Promise<void> {
  if (evidence.blocked) return;
  const claimId = storedClaimIdentity(projectId);
  if (!claimId) throw new Error('Browser tool claim identity is unavailable.');
  for (const outcome of evidence.existingOutcomes) {
    if (!active()) return;
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/tool-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SERVER_RUN_CAPABILITY_HEADER]: capability },
      body: JSON.stringify({ projectId, claimId, toolCallId: outcome.toolCallId,
        argsDigest: outcome.argsDigest,
        ...(outcome.error !== undefined ? { error: outcome.error }
          : { result: projectServerRunToolResult(outcome.result) }),
      }),
    });
    if (!response.ok) throw new Error(`补交工具结果失败：HTTP ${response.status}`);
    if (active()) clearStoredToolAttempt(projectId, outcome.toolCallId);
  }
}
