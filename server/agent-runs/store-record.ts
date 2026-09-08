import type { AgentRunContext } from '../../src/persist/agentRuntimeStore';
import type { ServerRun } from './store-types';

export interface CreateServerRunInput {
  readonly id?: string;
  readonly projectId: string;
  readonly sessionGeneration: string;
  readonly backend?: string;
  readonly provider: string;
  readonly model: string;
  readonly askOnly?: boolean;
  readonly references?: readonly unknown[];
  readonly externalSessionId?: string;
  readonly context?: unknown;
  readonly requestShapeHash?: string;
  readonly userInputDigest?: string;
}

export interface CreatedServerRun {
  readonly run: ServerRun;
  readonly capability: string;
}

function createRuntimeContext(
  input: CreateServerRunInput,
  capabilityVerifier: string,
  digest: string,
): AgentRunContext {
  return {
    requestShapeHash: digest,
    modelId: input.model,
    activeToolCount: 0,
    serverRunCapabilityVerifier: capabilityVerifier,
    transportStatus: 'queued',
    transportError: null,
  };
}

export function createRunRecord(
  input: CreateServerRunInput,
  id: string,
  createdAt: number,
  digest: string,
  capabilityVerifier: string,
): ServerRun {
  const runtimeContext = createRuntimeContext(input, capabilityVerifier, digest);
  return {
    id,
    projectId: input.projectId,
    sessionGeneration: input.sessionGeneration,
    capabilityVerifier,
    requestShapeHash: digest,
    backend: input.backend ?? 'api',
    provider: input.provider,
    model: input.model,
    askOnly: input.askOnly === true,
    references: input.references ? [...input.references] : [],
    ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
    status: 'queued',
    createdAt,
    events: [],
    error: null,
    retainedEventBytes: 0,
    replayStart: 1,
    subscriberCount: 0,
    waiters: new Set(),
    eventCursor: 0,
    pendingEventBytes: 0,
    pendingEventCount: 0,
    runtimeContext,
    toolRequests: new Map(),
    metrics: {
      requests: 0,
      inputTokens: 0,
      freshInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  };
}
