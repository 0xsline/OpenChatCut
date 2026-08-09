import type {
  AgentCacheMissReason,
  AgentRunContext,
} from '../persist/agentRuntimeTypes';

const USAGE_KEYS = [
  'modelRequestCount',
  'totalInputTokens',
  'totalFreshInputTokens',
  'totalCacheReadTokens',
  'totalCacheWriteTokens',
  'totalOutputTokens',
  'totalReasoningTokens',
  'totalRetryCount',
  'totalMediaInputs',
  'totalMediaTokenEstimate',
  'cacheHitRatio',
  'lastRequestAt',
] as const satisfies readonly (keyof AgentRunContext)[];

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function freshInputTokens(context: AgentRunContext): number {
  if (context.noCacheTokens !== undefined || context.cacheWriteTokens !== undefined) {
    return finite(context.noCacheTokens) + finite(context.cacheWriteTokens);
  }
  return Math.max(0, finite(context.inputTokens) - finite(context.cacheReadTokens));
}

function missReason(
  previous: AgentRunContext | undefined,
  current: AgentRunContext,
  recordedAt: number,
): AgentCacheMissReason {
  if (finite(current.cacheReadTokens) > 0 || freshInputTokens(current) === 0) return 'none';
  if (!previous?.lastRequestAt) return 'first_request';
  if (previous.modelId && current.modelId && previous.modelId !== current.modelId) return 'model_changed';
  if (previous.systemDigest && current.systemDigest
    && previous.systemDigest !== current.systemDigest) return 'system_prompt_changed';
  if (previous.toolSchemaDigest && current.toolSchemaDigest
    && previous.toolSchemaDigest !== current.toolSchemaDigest) return 'tool_surface_changed';
  const ttlMs = current.cacheTtlMs ?? previous.cacheTtlMs;
  if (ttlMs && recordedAt - previous.lastRequestAt > ttlMs) return 'idle_ttl_expired';
  return 'unknown';
}

export function preserveAgentRunUsage(
  context: AgentRunContext,
  previous: AgentRunContext | undefined,
): AgentRunContext {
  if (!previous) return context;
  const retained = Object.fromEntries(USAGE_KEYS.flatMap((key) => {
    const value = previous[key];
    return value === undefined ? [] : [[key, value]];
  }));
  return { ...context, ...retained };
}

export function accumulateAgentRunUsage(
  previous: AgentRunContext | undefined,
  current: AgentRunContext,
  recordedAt = Date.now(),
): AgentRunContext {
  const totalInputTokens = finite(previous?.totalInputTokens) + finite(current.inputTokens);
  const totalCacheReadTokens = finite(previous?.totalCacheReadTokens)
    + finite(current.cacheReadTokens);
  const totalFreshInputTokens = finite(previous?.totalFreshInputTokens)
    + freshInputTokens(current);
  return {
    ...current,
    modelRequestCount: finite(previous?.modelRequestCount) + 1,
    totalInputTokens,
    totalFreshInputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens: finite(previous?.totalCacheWriteTokens)
      + finite(current.cacheWriteTokens),
    totalOutputTokens: finite(previous?.totalOutputTokens) + finite(current.outputTokens),
    totalReasoningTokens: finite(previous?.totalReasoningTokens)
      + finite(current.reasoningTokens),
    totalRetryCount: finite(previous?.totalRetryCount) + finite(current.retryCount),
    totalMediaInputs: finite(previous?.totalMediaInputs) + finite(current.mediaInputCount),
    totalMediaTokenEstimate: finite(previous?.totalMediaTokenEstimate)
      + finite(current.mediaTokenEstimate),
    cacheHitRatio: totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : 0,
    cacheMissTokens: freshInputTokens(current),
    cacheMissReason: missReason(previous, current, recordedAt),
    lastRequestAt: recordedAt,
  };
}
