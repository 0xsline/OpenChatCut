import { useEffect, useRef } from 'react';
import type { ToolResultPart } from 'ai';
import { loadChat, saveChat } from '../persist/projectStore';
import {
  clearProposal,
  loadProposalRecord,
  restorePreparedProposal,
  settleProposal,
  type ProposalSettlementOutcome,
  type StoredProposalRecord,
} from '../persist/proposalStore';
import {
  loadExternalProposal,
  type StoredExternalProposal,
} from '../persist/externalProposalStore';
import {
  adoptAgentSessionWriteGeneration,
  currentAgentSessionGeneration,
} from '../persist/agentSessionGeneration';
import { normalizeLlmMessages, prepareMessagesForProvider } from './messages';
import { normalizeLlmProvider, PROVIDER } from './providerConfig';
import { ensureAgentRetryMetadata, initialAgentMessages, type DisplayMessage } from './agent-session';
import { isProposalStale, type Proposal } from './proposal';
import { parseAgentChangeLog } from './changeLog';
import { projectToolResultForPersistence } from './runtime-artifact';
import {
  currentAgentRunOwnerInstanceId,
  resumeAgentRun,
  stopAgentRunLeases,
  type ProposalRuntimeStatus,
} from './runtime-ledger';
import {
  loadAgentRuntimeSidecar,
  recoverInterruptedAgentRuns,
  type AgentRunStatus,
} from '../persist/agentRuntimeStore';
import type { AgentHookState } from './useAgentState';
import type { LLMMessage } from './runtime';

export async function recordProposalOutcome(
  projectId: string,
  proposal: Proposal,
  status: ProposalRuntimeStatus,
  finalStatus: AgentRunStatus,
  summary: string,
): Promise<void> {
  if (!proposal.agentRunId || !proposal.id) return;
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const run = sidecar.runs.find((candidate) => candidate.runId === proposal.agentRunId);
  if (!run) throw new Error('Agent proposal run is missing.');
  if (['completed', 'failed', 'aborted', 'interrupted'].includes(run.status)) return;
  const recorder = await resumeAgentRun(projectId, proposal.agentRunId);
  if (!recorder) throw new Error('Agent proposal is active in another editor or no longer resumable.');
  await recorder.recordProposal(proposal.id, status);
  await recorder.finalize(finalStatus, summary);
}

function externalProposalRunIds(external: StoredExternalProposal | null): Set<string> {
  return external && (external.status === 'drafting' || external.status === 'awaiting_review')
    && external.agentRunId ? new Set([external.agentRunId]) : new Set();
}

function preservedProposalRunIds(
  record: StoredProposalRecord | null,
  external: StoredExternalProposal | null,
): Set<string> {
  const ids = new Set<string>();
  if (record?.phase !== 'settled' && record?.proposal.agentRunId) {
    ids.add(record.proposal.agentRunId);
  }
  if (external && (external.status === 'drafting' || external.status === 'awaiting_review')
      && external.agentRunId) ids.add(external.agentRunId);
  return ids;
}

const SETTLEMENT_RUNTIME: Record<ProposalSettlementOutcome, {
  status: ProposalRuntimeStatus;
  finalStatus: AgentRunStatus;
  summary: string;
}> = {
  applied: { status: 'applied', finalStatus: 'completed', summary: 'applied proposal recovered' },
  rejected: { status: 'rejected', finalStatus: 'aborted', summary: 'rejected proposal recovered' },
  stale: { status: 'stale', finalStatus: 'aborted', summary: 'stale proposal recovered' },
  reproposed: { status: 'reproposed', finalStatus: 'aborted', summary: 'replaced proposal recovered' },
};

async function finalizeRecoveredProposal(
  projectId: string,
  proposal: Proposal,
  outcome: ProposalSettlementOutcome,
): Promise<void> {
  const runtime = SETTLEMENT_RUNTIME[outcome];
  await recordProposalOutcome(projectId, proposal, runtime.status, runtime.finalStatus, runtime.summary);
  await clearProposal(projectId, proposal.id);
}

async function recoverDurableProposal(
  projectId: string,
  record: StoredProposalRecord | null,
  currentDoc: Parameters<typeof isProposalStale>[1],
): Promise<Proposal | null> {
  if (!record) return null;
  if (record.phase === 'settled') {
    await finalizeRecoveredProposal(projectId, record.proposal, record.settlement!.outcome);
    return null;
  }
  if (record.phase === 'prepared' && !isProposalStale(record.proposal, currentDoc)) {
    return record.proposal;
  }
  if (record.phase === 'applying'
      && JSON.stringify(currentDoc) === JSON.stringify(record.proposal.baseDoc)) {
    await restorePreparedProposal(projectId, record.proposal);
    return record.proposal;
  }
  const outcome = record.phase === 'applying'
    && JSON.stringify(currentDoc) === JSON.stringify(record.application!.resultDoc)
    ? 'applied'
    : 'stale';
  await settleProposal(projectId, record.proposal, outcome);
  await finalizeRecoveredProposal(projectId, record.proposal, outcome);
  return null;
}

async function claimRecoveredProposalRun(
  projectId: string,
  record: StoredProposalRecord | null,
) {
  const runId = record?.phase !== 'settled' ? record?.proposal.agentRunId : undefined;
  if (!runId) return null;
  const recorder = await resumeAgentRun(projectId, runId);
  if (recorder) return recorder;
  const run = (await loadAgentRuntimeSidecar(projectId)).runs
    .find((candidate) => candidate.runId === runId);
  if (run && !['completed', 'failed', 'aborted', 'interrupted'].includes(run.status)) {
    throw new Error('Agent proposal is active in another editor.');
  }
  return null;
}

export async function loadRecoveredAgentSession(
  projectId: string,
  alive: () => boolean,
  recover: typeof recoverInterruptedAgentRuns = recoverInterruptedAgentRuns,
  currentDoc?: Parameters<typeof isProposalStale>[1],
) {
  const generation = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, generation);
  const [record, external, saved] = await Promise.all([
    loadProposalRecord(projectId),
    loadExternalProposal(projectId),
    loadChat(projectId),
  ]);
  if (!alive() || await currentAgentSessionGeneration(projectId) !== generation) return null;
  const externalRunIds = externalProposalRunIds(external);
  await recover(
    projectId,
    Date.now(),
    preservedProposalRunIds(record, external),
    externalRunIds,
    currentAgentRunOwnerInstanceId(),
  );
  if (!alive() || await currentAgentSessionGeneration(projectId) !== generation) return null;
  const proposalRecorder = await claimRecoveredProposalRun(projectId, record);
  if (!alive() || await currentAgentSessionGeneration(projectId) !== generation) {
    await proposalRecorder?.releaseLease().catch(() => undefined);
    return null;
  }
  const pending = currentDoc
    ? await recoverDurableProposal(projectId, record, currentDoc)
    : record?.phase === 'prepared' ? record.proposal : null;
  if (pending?.agentRunId) {
    if (!proposalRecorder) {
      await settleProposal(projectId, pending, 'stale');
      await clearProposal(projectId, pending.id);
      throw new Error('Agent proposal run is no longer resumable.');
    }
    await proposalRecorder.finalize('waiting_approval', 'proposal recovered awaiting approval');
  }
  if (!alive() || await currentAgentSessionGeneration(projectId) !== generation) {
    await proposalRecorder?.releaseLease().catch(() => undefined);
    return null;
  }
  return { saved, pending, generation };
}

export async function hydrateAgentSession(
  state: AgentHookState,
  projectId: string,
  alive: () => boolean,
): Promise<void> {
  const loaded = await loadRecoveredAgentSession(
    projectId,
    alive,
    recoverInterruptedAgentRuns,
    state.ctxRef.current.getDoc(),
  );
  if (!loaded || !alive()) return;
  const { saved, pending } = loaded;
  state.setMessages(saved ? ensureAgentRetryMetadata(saved.messages as DisplayMessage[]) : []);
  state.setChangeLog(parseAgentChangeLog(saved?.changeLog));
  if (saved) {
    const source = normalizeLlmProvider(saved.llmProvider ?? 'anthropic');
    state.llmRef.current = prepareMessagesForProvider(normalizeLlmMessages(saved.llm), source, PROVIDER);
  } else {
    state.llmRef.current = initialAgentMessages();
  }
  state.toolFailuresRef.current.restore(saved?.toolFailures);
  state.refreshEstimatedContextUsage();
  state.llmProviderRef.current = PROVIDER;
  if (pending) state.setProposal(pending);
  state.hydratedRef.current = true;
  state.setHydrated(true);
}

export function cleanupAgentHydration(
  state: AgentHookState,
  projectId: string,
  stopLeases: typeof stopAgentRunLeases = stopAgentRunLeases,
): void {
  const activeExecution = state.runningRef.current || state.abortRef.current !== null;
  state.pendingGuardRef.current?.resolve('deny');
  state.abortRef.current?.abort();
  if (!activeExecution) void stopLeases(projectId);
}

export function useAgentHydration(state: AgentHookState, projectId: string, enabled = true): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!enabled) return undefined;
    let mounted = true;
    const current = stateRef.current;
    const hydrationEpoch = ++current.hydrationEpochRef.current;
    const alive = () => mounted && current.hydrationEpochRef.current === hydrationEpoch;
    current.hydratedRef.current = false;
    current.toolFailuresRef.current.clear();
    current.setHydrated(false);
    current.setChangeLog([]);
    current.setProposal(null);
    current.setProposalStale(false);
    void hydrateAgentSession(current, projectId, alive).catch((error) => {
      if (!alive()) return;
      current.setMessages((messages) => [...messages, {
        role: 'error',
        text: `Agent 恢复状态无法验证：${error instanceof Error ? error.message : String(error)}`,
      }]);
      current.hydratedRef.current = true;
      current.setHydrated(true);
    });
    return () => {
      mounted = false;
      cleanupAgentHydration(current, projectId);
    };
  }, [enabled, projectId, state.refreshEstimatedContextUsage]);
}

function messagesForPersistence(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.map((message) => !message.tool
    ? message
    : {
      ...message,
      tool: {
        ...message.tool,
        result: projectToolResultForPersistence(message.tool.result),
      },
    });
}

type ToolResultOutput = ToolResultPart['output'];

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string'
      || typeof value === 'boolean' || typeof value === 'number') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function isStringMap(value: unknown): boolean {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

function hasValidProviderOptions(value: object): boolean {
  if (!('providerOptions' in value) || value.providerOptions === undefined) return true;
  return isObject(value.providerOptions)
    && Object.values(value.providerOptions).every((options) => isObject(options) && isJsonValue(options));
}


function isPersistedFileData(value: unknown): boolean {
  if (!isObject(value) || !('type' in value)) return false;
  if (value.type === 'data') return 'data' in value && typeof value.data === 'string';
  if (value.type === 'reference') return 'reference' in value && isStringMap(value.reference);
  if (value.type === 'text') return 'text' in value && typeof value.text === 'string';
  return false;
}

function isPersistedToolContentPart(value: unknown): boolean {
  if (!isObject(value) || !('type' in value) || !hasValidProviderOptions(value)) return false;
  if (value.type === 'text') return 'text' in value && typeof value.text === 'string';
  if (value.type === 'file') {
    return 'data' in value && isPersistedFileData(value.data)
      && 'mediaType' in value && typeof value.mediaType === 'string'
      && (!('filename' in value) || value.filename === undefined
        || typeof value.filename === 'string');
  }
  if (value.type === 'file-data' || value.type === 'image-data') {
    return 'data' in value && typeof value.data === 'string'
      && 'mediaType' in value && typeof value.mediaType === 'string'
      && (!('filename' in value) || value.filename === undefined
        || typeof value.filename === 'string');
  }
  if (value.type === 'file-url' || value.type === 'image-url') {
    return 'url' in value && typeof value.url === 'string'
      && (!('mediaType' in value) || value.mediaType === undefined
        || typeof value.mediaType === 'string');
  }
  if (value.type === 'file-id' || value.type === 'image-file-id') {
    return 'fileId' in value
      && (typeof value.fileId === 'string' || isStringMap(value.fileId));
  }
  if (value.type === 'file-reference' || value.type === 'image-file-reference') {
    return 'providerReference' in value && isStringMap(value.providerReference);
  }
  return value.type === 'custom';
}

function isToolResultOutput(value: unknown): value is ToolResultOutput {
  if (!isObject(value) || !('type' in value) || !hasValidProviderOptions(value)) return false;
  if (value.type === 'text' || value.type === 'error-text') {
    return 'value' in value && typeof value.value === 'string';
  }
  if (value.type === 'json' || value.type === 'error-json') {
    return 'value' in value && isJsonValue(value.value);
  }
  if (value.type === 'execution-denied') {
    return !('reason' in value) || value.reason === undefined || typeof value.reason === 'string';
  }
  return value.type === 'content' && 'value' in value
    && Array.isArray(value.value) && value.value.every(isPersistedToolContentPart);
}

function projectToolOutputForPersistence(output: ToolResultOutput): ToolResultOutput {
  const projected = projectToolResultForPersistence(output);
  if (isToolResultOutput(projected)) return projected;
  return {
    type: 'text',
    value: typeof projected === 'string'
      ? projected
      : '[tool result omitted: invalid durable projection]',
  };
}


export function projectLlmMessagesForPersistence(messages: readonly LLMMessage[]): LLMMessage[] {
  return messages.map((message) => message.role !== 'tool'
    ? message
    : {
      ...message,
      content: message.content.map((part) => part.type !== 'tool-result'
        ? part
        : { ...part, output: projectToolOutputForPersistence(part.output) }),
    });
}

function persistAgentSession(state: AgentHookState, projectId: string): void {
  void saveChat(projectId, {
    messages: messagesForPersistence(state.messages),
    llm: projectLlmMessagesForPersistence(state.llmRef.current),
    changeLog: state.changeLog,
    llmFormat: 'ai-sdk-v1',
    llmProvider: state.llmProviderRef.current,
    toolFailures: state.toolFailuresRef.current.snapshot(),
  });
}

export function useAgentPersistence(state: AgentHookState, projectId: string, enabled = true): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!enabled) return undefined;
    const current = stateRef.current;
    if (!current.hydratedRef.current || current.runningRef.current) return undefined;
    persistAgentSession(current, projectId);
    return undefined;
  }, [enabled, state.changeLog, state.messages, state.running, projectId]);
}
