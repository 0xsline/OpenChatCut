import {
  addAgentCheckpoint,
  appendAgentRunEvent,
  createAgentRun,
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  MAX_ARTIFACT_BYTES,
  recoverInterruptedAgentRuns,
  releaseAgentRunLease,
  patchAgentRun,
  sha256Text,
  storeAgentArtifact,
  upsertAgentApproval,
  type AgentApprovalRecord,
  type AgentArtifactRecord,
  type AgentRunContext,
  type AgentRunRecord,
  type AgentRunStatus,
  type AgentToolOutcome,
  updateAgentRunLease,
} from '../persist/agentRuntimeStore';
import {
  redactTextForAgentRuntime,
  sanitizeJsonForArtifact,
  type AgentArtifactRef,
} from './runtime-artifact';
import {
  accumulateAgentRunUsage,
  preserveAgentRunUsage,
} from './run-context-usage';

export const TOOL_ARTIFACT_THRESHOLD = 16_000;
const PREVIEW_CHARS = 800;
const SUMMARY_CHARS = 1_200;
const TERMINAL = new Set<AgentRunStatus>(['completed', 'failed', 'aborted', 'interrupted']);
const AGENT_RUN_LEASE_MS = 120_000;
const AGENT_RUN_HEARTBEAT_MS = 30_000;
const RUN_OWNER_KEY = 'openchatcut.agent-run-owner';

function runOwnerInstanceId(): string {
  try {
    const existing = sessionStorage.getItem(RUN_OWNER_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(RUN_OWNER_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

const RUN_OWNER_INSTANCE_ID = runOwnerInstanceId();
export function currentAgentRunOwnerInstanceId(): string {
  return RUN_OWNER_INSTANCE_ID;
}
const ACTIVE_RECORDERS = new Map<string, Set<AgentRunRecorder>>();

export async function stopAgentRunLeases(projectId: string): Promise<void> {
  const recorders = ACTIVE_RECORDERS.get(projectId);
  if (!recorders) return;
  await Promise.all([...recorders].map((recorder) => recorder.releaseLease().catch(() => undefined)));
}
export interface StartAgentRunInput {
  readonly projectId: string;
  readonly userInput: string;
  readonly askOnly: boolean;
  readonly externalSessionId?: string;
}
export interface AgentContextCheckpointInput {
  readonly checkpointId?: string;
  readonly summary: string;
  readonly sourceText: string;
  readonly sourceMessageCount: number;
  readonly sourceDigest: string;
  readonly summaryDigest?: string;
  readonly createdAt: number;
}
export interface ToolRequestInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly operationId?: string;
}
export interface ToolLifecycleInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly operationId?: string;
}
export interface ToolOutcomeInput extends Omit<ToolLifecycleInput, 'argsDigest'> {
  readonly argsDigest?: string;
  readonly outcome: AgentToolOutcome;
  readonly resultDigest?: string;
  readonly artifactId?: string;
}
export interface ApprovalRequestInput extends ToolLifecycleInput {
  readonly summary?: string;
}
export interface ArchiveToolResultInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly forceArchive?: boolean;
}
export type ProposalRuntimeStatus = 'created' | 'applied' | 'rejected' | 'stale' | 'reproposed';

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
function sanitizeText(value: unknown, maxChars = SUMMARY_CHARS): string {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = redactTextForAgentRuntime(text)
    .replace(/\b(token|api[-_]?key|authorization|cookie|password|secret|credential)\s*(?::|=|\bis\b)\s*([^\s,;]+)/gi, '$1=[REDACTED]');
  return text.trim().slice(0, maxChars);
}
function sanitizeOutcomeForPersistence(outcome: AgentToolOutcome): AgentToolOutcome {
  return {
    kind: outcome.kind,
    ...(outcome.code === undefined ? {} : { code: sanitizeText(outcome.code, 240) }),
    ...(outcome.operationId === undefined ? {} : { operationId: outcome.operationId }),
    ...(outcome.artifactId === undefined ? {} : { artifactId: outcome.artifactId }),
    ...(outcome.summary === undefined ? {} : { summary: sanitizeText(outcome.summary) }),
  };
}
async function uniqueArtifactId(projectId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 18);
    if (!await loadAgentArtifact(projectId, id)) return id;
  }
  throw new Error('Unable to allocate a unique agent artifact id.');
}
function artifactRef(record: AgentArtifactRecord): AgentArtifactRef {
  return {
    artifactId: record.artifactId,
    bodySha256: record.bodySha256,
    originalChars: record.originalChars,
    storedBytes: record.originalBytes,
    redacted: record.redacted,
    binaryOmitted: record.binaryOmitted,
  };
}

export class AgentRunRecorder {
  readonly projectId: string;
  readonly runId: string;
  private tail: Promise<void> = Promise.resolve();
  private leaseTimer: NodeJS.Timeout | null = null;
  private leaseOwned = true;
  private readonly leaseToken: string;
  private lastActualContext: AgentRunContext | null | undefined;

  constructor(projectId: string, runId: string, leaseToken: string) {
    this.projectId = projectId;
    this.runId = runId;
    this.leaseToken = leaseToken;
    this.leaseTimer = setInterval(() => this.heartbeat(), AGENT_RUN_HEARTBEAT_MS);
    if (typeof this.leaseTimer === 'object' && 'unref' in this.leaseTimer) this.leaseTimer.unref();
    const active = ACTIVE_RECORDERS.get(projectId) ?? new Set<AgentRunRecorder>();
    active.add(this);
    ACTIVE_RECORDERS.set(projectId, active);
  }

  private heartbeat(): void {
    void updateAgentRunLease(
      this.projectId,
      this.runId,
      RUN_OWNER_INSTANCE_ID,
      this.leaseToken,
      Date.now() + AGENT_RUN_LEASE_MS,
      false,
    ).then((lease) => {
      if (lease) return;
      this.leaseOwned = false;
      this.stopLease();
    }, () => {
      // Transient persistence failures retain the timer; the remaining lease
      // leaves several heartbeat windows before another owner may recover.
    });
  }

  stopLease(): void {
    clearInterval(this.leaseTimer ?? undefined);
    this.leaseTimer = null;
    const active = ACTIVE_RECORDERS.get(this.projectId);
    active?.delete(this);
    if (!active?.size) ACTIVE_RECORDERS.delete(this.projectId);
  }
  async releaseLease(): Promise<void> {
    this.stopLease();
    await releaseAgentRunLease(this.projectId, this.runId, RUN_OWNER_INSTANCE_ID, this.leaseToken);
  }

  async cancelPendingApprovalsOnHydration(): Promise<void> {
    const runIds = new Set([this.runId]);
    await recoverInterruptedAgentRuns(
      this.projectId,
      Date.now(),
      runIds,
      runIds,
      RUN_OWNER_INSTANCE_ID,
      this.leaseToken,
    );
  }

  async disconnect(): Promise<void> {
    this.stopLease();
    const runIds = new Set([this.runId]);
    await recoverInterruptedAgentRuns(
      this.projectId,
      Date.now(),
      runIds,
      runIds,
      RUN_OWNER_INSTANCE_ID,
      this.leaseToken,
    );
    await releaseAgentRunLease(
      this.projectId,
      this.runId,
      RUN_OWNER_INSTANCE_ID,
      this.leaseToken,
    );
  }

  private async renewOwnership(): Promise<void> {
    const lease = await updateAgentRunLease(
      this.projectId,
      this.runId,
      RUN_OWNER_INSTANCE_ID,
      this.leaseToken,
      Date.now() + AGENT_RUN_LEASE_MS,
      false,
    );
    if (lease) return;
    this.leaseOwned = false;
    this.stopLease();
    throw new Error(`Agent run ownership lost: ${this.runId}`);
  }
  confirmOwnership(): Promise<void> {
    return this.serialize(async () => undefined);
  }
  private serialize<T>(work: () => Promise<T>, allowSettled = false): Promise<T> {
    const result = this.tail.catch(() => undefined).then(async () => {
      if (allowSettled) {
        const run = (await loadAgentRuntimeSidecar(this.projectId)).runs.find((item) => item.runId === this.runId);
        if (run && TERMINAL.has(run.status)) return work();
      }
      if (!this.leaseOwned) throw new Error(`Agent run ownership lost: ${this.runId}`);
      await this.renewOwnership();
      return work();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async previousActualContext(): Promise<AgentRunContext | undefined> {
    if (this.lastActualContext !== undefined) return this.lastActualContext ?? undefined;
    const run = (await loadAgentRuntimeSidecar(this.projectId)).runs
      .find((item) => item.runId === this.runId);
    const previous = run?.events.findLast((event) => event.type === 'context_usage')?.context;
    this.lastActualContext = previous ?? null;
    return previous;
  }
  configure(input: { readonly modelId: string; readonly backend: string; readonly askOnly?: boolean }): Promise<void> {
    return this.serialize(async () => {
      const modelId = sanitizeText(input.modelId, 160);
      const backend = sanitizeText(input.backend, 80);
      await patchAgentRun(this.projectId, this.runId, {
        modelId, backend,
        ...(input.askOnly === undefined ? {} : { askOnly: input.askOnly }),
      });
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'configured', summary: `${backend}:${modelId}`,
      });
    });
  }

  recordContext(context: AgentRunContext): Promise<void> {
    return this.serialize(async () => {
      const projected = preserveAgentRunUsage(context, await this.previousActualContext());
      await patchAgentRun(this.projectId, this.runId, { context: projected });
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'context_projected', summary: context.requestShapeHash,
      });
    });
  }
  recordContextUsage(context: AgentRunContext): Promise<void> {
    return this.serialize(async () => {
      const accumulated = accumulateAgentRunUsage(
        await this.previousActualContext(),
        context,
      );
      this.lastActualContext = accumulated;
      await patchAgentRun(this.projectId, this.runId, { context: accumulated });
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'context_usage',
        summary: context.requestShapeHash,
        context: accumulated,
      });
    });
  }


  recordCheckpoint(input: AgentContextCheckpointInput): Promise<void> {
    return this.serialize(async () => {
      const sourceText = redactTextForAgentRuntime(input.sourceText);
      const summary = redactTextForAgentRuntime(input.summary);
      const [digest, summaryDigest] = await Promise.all([
        sha256Text(sourceText), sha256Text(summary),
      ]);
      if (digest !== input.sourceDigest) throw new Error('context_integrity: checkpoint source digest mismatch');
      if (input.summaryDigest && summaryDigest !== input.summaryDigest) {
        throw new Error('context_integrity: checkpoint summary digest mismatch');
      }
      const artifactId = await uniqueArtifactId(this.projectId);
      const bodyBytes = new TextEncoder().encode(sourceText).byteLength;
      if (bodyBytes > MAX_ARTIFACT_BYTES) throw new Error('context_integrity: checkpoint source exceeds artifact cap');
      const stored = await storeAgentArtifact({
        version: 1, artifactId, projectId: this.projectId, runId: this.runId,
        kind: 'checkpoint-source', bodySha256: digest, originalBytes: bodyBytes,
        originalChars: sourceText.length, createdAt: input.createdAt,
        redacted: sourceText !== input.sourceText, binaryOmitted: false, body: sourceText,
      });
      if (!stored) throw new Error('context_integrity: checkpoint source could not be archived');
      const checkpointId = input.checkpointId ?? crypto.randomUUID();
      await addAgentCheckpoint({
        version: 1, checkpointId, projectId: this.projectId, runId: this.runId,
        summary, summaryDigest,
        sourceMessageCount: input.sourceMessageCount, sourceDigest: digest,
        sourceArtifactId: artifactId, createdAt: input.createdAt,
      });
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'checkpoint_created', checkpointId, summary: `messages=${input.sourceMessageCount}`,
      });
    });
  }

  recordToolRequested(input: ToolRequestInput): Promise<{ argsDigest: string }> {
    return this.serialize(async () => {
      const argsDigest = await digestAgentToolArgs(input.args);
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'tool_requested', toolCallId: input.toolCallId, toolName: input.toolName,
        operationId: input.operationId, argsDigest,
        summary: sanitizeText(`keys=${Object.keys(input.args).sort().join(',')}`, 400),
      });
      return { argsDigest };
    });
  }

  recordApprovalRequested(input: ApprovalRequestInput): Promise<AgentApprovalRecord> {
    return this.serialize(async () => {
      const now = Date.now();
      const record: AgentApprovalRecord = {
        version: 1, approvalId: `ap_${crypto.randomUUID().replaceAll('-', '').slice(0, 15)}`,
        projectId: this.projectId, runId: this.runId, toolCallId: input.toolCallId,
        toolName: input.toolName, argsDigest: input.argsDigest,
        operationId: input.operationId, status: 'pending', createdAt: now,
        summary: sanitizeText(input.summary),
      };
      await upsertAgentApproval(record);
      await patchAgentRun(this.projectId, this.runId, { status: 'waiting_approval' });
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'approval_requested', approvalId: record.approvalId,
        toolCallId: input.toolCallId, toolName: input.toolName,
        operationId: input.operationId, argsDigest: input.argsDigest,
      });
      return record;
    });
  }

  recordApprovalDecision(approvalId: string, decision: 'allowed' | 'denied'): Promise<void> {
    return this.serialize(async () => {
      const sidecar = await loadAgentRuntimeSidecar(this.projectId);
      const current = sidecar.approvals.find((item) => item.approvalId === approvalId);
      if (!current || current.runId !== this.runId) throw new Error(`Agent approval not found: ${approvalId}`);
      const next = { ...current, status: decision, decidedAt: Date.now() } satisfies AgentApprovalRecord;
      await upsertAgentApproval(next);
      await patchAgentRun(this.projectId, this.runId, { status: 'running' });
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'approval_decided', approvalId, toolCallId: current.toolCallId,
        toolName: current.toolName, operationId: current.operationId,
        argsDigest: current.argsDigest, summary: decision,
      });
    });
  }

  recordToolStarted(input: ToolLifecycleInput): Promise<void> {
    return this.serialize(async () => {
      await appendAgentRunEvent(this.projectId, this.runId, {
        type: 'tool_started', toolCallId: input.toolCallId, toolName: input.toolName,
        argsDigest: input.argsDigest, operationId: input.operationId,
      });
    });
  }

  recordToolOutcome(input: ToolOutcomeInput): Promise<void> {
    return this.serialize(() => appendAgentRunEvent(this.projectId, this.runId, {
      type: 'tool_outcome', toolCallId: input.toolCallId, toolName: input.toolName,
      argsDigest: input.argsDigest, operationId: input.operationId,
      resultDigest: input.resultDigest, outcome: sanitizeOutcomeForPersistence({
        ...input.outcome, ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      }),
    }).then(() => undefined));
  }

  archiveToolResult(input: ArchiveToolResultInput): Promise<AgentArtifactRef | null> {
    return this.serialize(async () => {
      if (!input.forceArchive
          && (input.toolName === 'read_agent_artifact' || input.toolName === 'load_skill')) return null;
      const sanitized = sanitizeJsonForArtifact(input.result);
      if (!sanitized) throw new Error('tool_result_archive: result could not be serialized safely');
      if (sanitized.originalChars <= TOOL_ARTIFACT_THRESHOLD) return null;
      if (sanitized.storedBytes > MAX_ARTIFACT_BYTES) {
        throw new Error('tool_result_archive: result exceeds the per-artifact storage limit');
      }
      const bodySha256 = await sha256Text(sanitized.body);
      const artifactId = await uniqueArtifactId(this.projectId);
      const record: AgentArtifactRecord = {
        version: 1, artifactId, projectId: this.projectId, runId: this.runId,
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
    });
  }

  recordProposal(proposalId: string, status: ProposalRuntimeStatus): Promise<void> {
    return this.serialize(async () => {
      const type = `proposal_${status}` as const;
      const sidecar = await loadAgentRuntimeSidecar(this.projectId);
      const run = sidecar.runs.find((item) => item.runId === this.runId);
      if (!run) throw new Error(`Agent run not found: ${this.runId}`);
      await patchAgentRun(this.projectId, this.runId, {
        proposalIds: [...new Set([...run.proposalIds, proposalId])],
      });
      await appendAgentRunEvent(this.projectId, this.runId, { type, proposalId });
    });
  }
  finalize(status: AgentRunStatus, summary?: string): Promise<void> {
    return this.serialize(async () => {
      try {
        const current = await loadAgentRuntimeSidecar(this.projectId);
        const run = current.runs.find((item) => item.runId === this.runId);
        if (!run) throw new Error(`Agent run not found: ${this.runId}`);
        if (TERMINAL.has(run.status)) return;
        const finalSummary = sanitizeText(summary);
        await patchAgentRun(this.projectId, this.runId, {
          status, ...(finalSummary ? { finalSummary } : {}),
        });
        if (TERMINAL.has(status)) {
          await appendAgentRunEvent(this.projectId, this.runId, {
            type: 'final', summary: finalSummary || status,
          });
        }
      } finally {
        if (TERMINAL.has(status)) this.stopLease();
      }
    }, true);
  }
}
export async function startAgentRun(input: StartAgentRunInput): Promise<AgentRunRecorder> {
  const now = Date.now();
  const runId = `run_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const userInputAudit = redactTextForAgentRuntime(input.userInput);
  const run: AgentRunRecord = {
    version: 1, runId, projectId: input.projectId, status: 'running',
    askOnly: input.askOnly, userInputPreview: userInputAudit.trim().slice(0, PREVIEW_CHARS),
    userInputDigest: await sha256Text(userInputAudit), createdAt: now, updatedAt: now,
    ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    artifactIds: [], checkpointIds: [], proposalIds: [], events: [],
  };
  await createAgentRun(run);
  const lease = await updateAgentRunLease(
    input.projectId,
    runId,
    RUN_OWNER_INSTANCE_ID,
    undefined,
    now + AGENT_RUN_LEASE_MS,
    true,
    now,
  );
  if (!lease) throw new Error(`Agent run ownership could not be claimed: ${runId}`);
  return new AgentRunRecorder(input.projectId, runId, lease.leaseToken);
}
export async function resumeAgentRun(projectId: string, runId: string, claimedLeaseToken?: string): Promise<AgentRunRecorder | null> {
  for (const recorder of ACTIVE_RECORDERS.get(projectId) ?? []) if (recorder.runId === runId) return recorder;
  if (claimedLeaseToken) return new AgentRunRecorder(projectId, runId, claimedLeaseToken);
  const lease = await updateAgentRunLease(
    projectId,
    runId,
    RUN_OWNER_INSTANCE_ID,
    undefined,
    Date.now() + AGENT_RUN_LEASE_MS,
    true,
  );
  return lease ? new AgentRunRecorder(projectId, runId, lease.leaseToken) : null;
}
