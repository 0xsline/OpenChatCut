import { randomUUID } from 'node:crypto';
import type {
  AgentContextCheckpoint,
  AgentContextUsage,
} from '../../src/agent/context-compaction';
import {
  addAgentCheckpoint,
  deleteAgentArtifacts,
  patchAgentRun,
  storeAgentArtifact,
  type AgentRunContext,
} from '../../src/persist/agentRuntimeStore';
import type { ServerRun, ServerRunMetrics } from './store-types';

export interface StoreMetricsDependencies {
  mirror: (run: ServerRun, work: () => Promise<void>) => Promise<void>;
  pushRunEvent: (run: ServerRun, type: string, data: unknown) => void;
  updateRuntimeContext: (
    run: ServerRun,
    patch: Partial<AgentRunContext>,
  ) => AgentRunContext;
}

function runMetrics(run: ServerRun): ServerRunMetrics {
  run.metrics ??= {
    requests: 0,
    inputTokens: 0,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  return run.metrics;
}

export function recordServerContextUsage(
  dependencies: StoreMetricsDependencies,
  run: ServerRun,
  usage: AgentContextUsage,
  activeToolCount: number,
): void {
  const metrics = runMetrics(run);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const freshInputTokens = usage.noCacheInputTokens
    ?? Math.max(0, usage.inputTokens - cacheReadTokens - cacheWriteTokens);
  metrics.requests += 1;
  metrics.inputTokens += usage.inputTokens;
  metrics.freshInputTokens += freshInputTokens;
  metrics.cacheReadTokens += cacheReadTokens;
  metrics.cacheWriteTokens += cacheWriteTokens;
  metrics.outputTokens += usage.outputTokens ?? 0;
  metrics.reasoningTokens += usage.reasoningTokens ?? 0;
  const context = dependencies.updateRuntimeContext(run, {
    requestShapeHash: run.requestShapeHash ?? run.runtimeContext.requestShapeHash,
    modelId: run.model,
    systemTokens: usage.systemTokens,
    historyTokens: usage.historyTokens,
    activeToolCount,
    toolSchemaCount: usage.toolCount,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    noCacheTokens: freshInputTokens,
    requestIndex: metrics.requests,
    modelRequestCount: metrics.requests,
    totalInputTokens: metrics.inputTokens,
    totalFreshInputTokens: metrics.freshInputTokens,
    totalCacheReadTokens: metrics.cacheReadTokens,
    totalCacheWriteTokens: metrics.cacheWriteTokens,
    totalOutputTokens: metrics.outputTokens,
    totalReasoningTokens: metrics.reasoningTokens,
    cacheHitRatio: metrics.inputTokens > 0
      ? metrics.cacheReadTokens / metrics.inputTokens
      : 0,
    cacheMissTokens: freshInputTokens,
    lastRequestAt: Date.now(),
  });
  dependencies.pushRunEvent(run, 'context-usage', { usage });
  void dependencies.mirror(run, async () => {
    await patchAgentRun(run.projectId, run.id, { context });
  });
}

export async function persistServerCheckpoint(
  dependencies: StoreMetricsDependencies,
  run: ServerRun,
  checkpoint: AgentContextCheckpoint,
): Promise<void> {
  const artifactId = `scp_${randomUUID().replaceAll('-', '').slice(0, 15)}`;
  const originalBytes = Buffer.byteLength(checkpoint.sourceText);
  await dependencies.mirror(run, async () => {
    const stored = await storeAgentArtifact({
      version: 1,
      artifactId,
      projectId: run.projectId,
      runId: run.id,
      kind: 'checkpoint-source',
      bodySha256: checkpoint.sourceDigest,
      originalBytes,
      originalChars: checkpoint.sourceText.length,
      createdAt: checkpoint.createdAt,
      redacted: true,
      binaryOmitted: false,
      body: checkpoint.sourceText,
    });
    if (!stored) {
      throw new Error('Server context checkpoint source could not be archived.');
    }
    try {
      await addAgentCheckpoint({
        version: 1,
        checkpointId: checkpoint.checkpointId,
        projectId: run.projectId,
        runId: run.id,
        summary: checkpoint.summary,
        summaryDigest: checkpoint.summaryDigest,
        sourceMessageCount: checkpoint.sourceMessageCount,
        sourceDigest: checkpoint.sourceDigest,
        sourceArtifactId: artifactId,
        createdAt: checkpoint.createdAt,
      });
    } catch (error) {
      await deleteAgentArtifacts(run.projectId, [artifactId]).catch(() => undefined);
      throw error;
    }
  });
  dependencies.pushRunEvent(run, 'checkpoint', {
    checkpointId: checkpoint.checkpointId,
    sourceDigest: checkpoint.sourceDigest,
    sourceMessageCount: checkpoint.sourceMessageCount,
  });
}
