export const AGENT_RUNTIME_VERSION = 1 as const;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_ARTIFACTS = 256;
export const MAX_PROJECT_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type AgentRunStatus =
  | 'running' | 'waiting_approval' | 'awaiting_user'
  | 'completed' | 'failed' | 'aborted' | 'interrupted';
export type AgentToolOutcomeKind =
  | 'success' | 'validation_failed' | 'denied' | 'aborted_before_side_effect'
  | 'stale' | 'retryable_failure' | 'outcome_unknown' | 'terminal_failure';
export interface AgentToolOutcome {
  readonly kind: AgentToolOutcomeKind;
  readonly code?: string;
  readonly operationId?: string;
  readonly artifactId?: string;
  readonly summary?: string;
}
export type AgentRunEventType =
  | 'configured' | 'context_projected' | 'context_usage' | 'checkpoint_created'
  | 'tool_requested' | 'tool_started' | 'tool_outcome'
  | 'approval_requested' | 'approval_decided'
  | 'proposal_created' | 'proposal_applied' | 'proposal_rejected'
  | 'proposal_stale' | 'proposal_reproposed' | 'final';
export interface AgentRunEvent {
  readonly eventId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: AgentRunEventType;
  readonly createdAt: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly operationId?: string;
  readonly argsDigest?: string;
  readonly resultDigest?: string;
  readonly approvalId?: string;
  readonly checkpointId?: string;
  readonly proposalId?: string;
  readonly outcome?: AgentToolOutcome;
  readonly summary?: string;
  readonly context?: AgentRunContext;
}
export type AgentCacheMissReason =
  | 'none'
  | 'first_request'
  | 'model_changed'
  | 'system_prompt_changed'
  | 'tool_surface_changed'
  | 'idle_ttl_expired'
  | 'unknown';
export interface AgentRunContext {
  readonly requestShapeHash: string;
  readonly modelId?: string;
  readonly systemDigest?: string;
  readonly toolSchemaDigest?: string;
  readonly systemTokens?: number;
  readonly toolSchemaChars?: number;
  readonly historyTokens?: number;
  readonly activeToolCount?: number;
  readonly toolSchemaCount?: number;
  readonly checkpointId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly noCacheTokens?: number;
  readonly cacheTtlMs?: number;
  readonly requestIndex?: number;
  readonly attemptIndex?: number;
  readonly retryCount?: number;
  readonly retryReasons?: readonly string[];
  readonly mediaInputCount?: number;
  readonly mediaTokenEstimate?: number;
  readonly modelRequestCount?: number;
  readonly totalInputTokens?: number;
  readonly totalFreshInputTokens?: number;
  readonly totalCacheReadTokens?: number;
  readonly totalCacheWriteTokens?: number;
  readonly totalOutputTokens?: number;
  readonly totalReasoningTokens?: number;
  readonly totalRetryCount?: number;
  readonly totalMediaInputs?: number;
  readonly totalMediaTokenEstimate?: number;
  readonly cacheHitRatio?: number;
  readonly cacheMissTokens?: number;
  readonly cacheMissReason?: AgentCacheMissReason;
  readonly lastRequestAt?: number;
  /** SHA-256 verifier only; never a bearer credential. */
  readonly serverRunCapabilityVerifier?: string;
  /** Durable server transport lifecycle; browser proposal settlement owns AgentRunRecord.status. */
  readonly transportStatus?: 'queued' | 'running' | 'awaiting-confirmation' | 'awaiting-user'
    | 'completed' | 'failed' | 'cancelled';
  readonly transportError?: string | null;
}
export interface AgentRunRecord {
  readonly version: 1;
  readonly runId: string;
  readonly projectId: string;
  readonly status: AgentRunStatus;
  readonly askOnly: boolean;
  readonly userInputPreview: string;
  readonly userInputDigest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ownerInstanceId?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: number;
  readonly modelId?: string;
  readonly backend?: string;
  readonly provider?: string;
  readonly externalSessionId?: string;
  readonly context?: AgentRunContext;
  readonly artifactIds: readonly string[];
  readonly checkpointIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly events: readonly AgentRunEvent[];
  readonly finalSummary?: string;
}
export type AgentApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';
export interface AgentApprovalRecord {
  readonly version: 1;
  readonly approvalId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly operationId?: string;
  readonly status: AgentApprovalStatus;
  readonly createdAt: number;
  readonly decidedAt?: number;
  readonly summary?: string;
}
export interface AgentCheckpointRecord {
  readonly version: 1;
  readonly checkpointId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly summary: string;
  readonly summaryDigest?: string;
  readonly sourceMessageCount: number;
  readonly sourceDigest: string;
  readonly sourceArtifactId: string;
  readonly createdAt: number;
}
export type AgentArtifactKind = 'tool-result' | 'checkpoint-source' | 'server-run-draft';
export interface AgentArtifactRecord {
  readonly version: 1;
  readonly artifactId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: AgentArtifactKind;
  readonly bodySha256: string;
  readonly originalBytes: number;
  readonly originalChars: number;
  readonly createdAt: number;
  readonly redacted: boolean;
  readonly binaryOmitted: boolean;
  readonly body: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}
export type AgentArtifactIndexEntry = Omit<AgentArtifactRecord, 'body' | 'version'>;
export interface AgentRuntimeSidecar {
  readonly version: 1;
  readonly revision: number;
  readonly projectId: string;
  /** Local fallback format; a reachable project store is the canonical CAS authority. */
  readonly durability: 'local-sidecar';
  readonly updatedAt: number;
  readonly lastWriterId?: string;
  readonly sessionGeneration?: string;
  readonly runs: readonly AgentRunRecord[];
  readonly approvals: readonly AgentApprovalRecord[];
  readonly checkpoints: readonly AgentCheckpointRecord[];
  readonly artifacts: readonly AgentArtifactIndexEntry[];
}
export interface AgentRuntimeSnapshot {
  readonly sidecar: AgentRuntimeSidecar;
  readonly artifacts: readonly AgentArtifactRecord[];
}
